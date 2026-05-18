import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatFileOrigin, ChatFileRecord } from "#services/workspace/types.ts";
import type { OneBotMessageSegment } from "#services/onebot/types.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import { inferSendableFileKind, resolveSendablePath } from "#services/workspace/sendablePath.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import {
  assetInternalPathUsageHints,
  buildChatFileHandleResultFromContext,
  buildLocalFileHandleResultFromContext
} from "../core/fileHandle.ts";
import { nextAction, withNextActions, type ToolNextAction } from "../core/toolNextActions.ts";
import {
  chatFileListPolicy,
  assetLocalPathPolicy,
  fileSendPolicy,
  localFileListPolicy,
  localFileMutationPolicy,
  localFileReadPolicy,
  localFileSearchPolicy
} from "../core/resultObservationPresets.ts";

const isLocalFileToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.localFiles.enabled;
const isChatFileToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.chatFiles.enabled;

function parseSessionTarget(sessionId: string): { userId?: string; groupId?: string } | null {
  const parsed = parseChatSessionIdentity(sessionId);
  if (!parsed) {
    return null;
  }
  return parsed.kind === "private"
    ? { userId: parsed.userId }
    : { groupId: parsed.groupId };
}

function enqueueToolSend(
  context: Parameters<NonNullable<typeof localFileToolHandlers.filesystem_send_to_chat>>[2],
  previewText: string,
  send: () => Promise<void>
): void {
  context.messageQueue.enqueueTextDetached({
    sessionId: context.lastMessage.sessionId,
    text: previewText,
    pacing: "humanized",
    send
  });
}

export const localFileToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_list",
        description: "查看本地路径。目录只列出直接子项，返回 path、items、truncated；文件返回元信息。path 默认为工作区根目录（\".\"）。需要跨目录找文件时用 filesystem_search，不要用巨大目录列表堆上下文。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 500, description: "目录列表最大条数，默认 200。" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileListPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_read",
        description: "读取本地文本文件，可按行截取。每次最多返回 400 行；超出时 truncated=true，并返回 next_actions 指向下一段。只读取任务需要的行段。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            start_line: { type: "number" },
            end_line: { type: "number" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileReadPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_write",
        description: "写入本地文本文件。mode=overwrite 覆盖或新建；append 追加；create 仅在文件不存在时创建。小改动优先用 filesystem_patch。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            mode: { type: "string", enum: ["overwrite", "append", "create"] }
          },
          required: ["path", "content"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileMutationPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_patch",
        description: "修改已存在的本地文本文件。优先用 old_text/new_text 做精确替换；需要多处 hunk 时用 unified diff patch，patch 头必须类似 @@ -2,3 +2,3 @@ 并带足够上下文行。若同时传 patch 与 old_text/new_text，会优先使用 patch。失败时按错误重新读取相关行段后再补 patch。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            patch: { type: "string", description: "unified diff 内容，例如 @@ -1,3 +1,3 @@\\n old\\n-line\\n+new\\n tail" },
            old_text: { type: "string", description: "要精确替换的原文片段。" },
            new_text: { type: "string", description: "替换后的文本。" }
          },
          required: ["path"],
          anyOf: [
            { required: ["path", "patch"] },
            { required: ["path", "old_text", "new_text"] }
          ],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileMutationPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_move",
        description: "移动或重命名本地文件或目录。",
        parameters: {
          type: "object",
          properties: {
            from_path: { type: "string" },
            to_path: { type: "string" }
          },
          required: ["from_path", "to_path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileMutationPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_copy",
        description: "复制本地文件。当前只支持文件，不支持目录；目录发送/复制后续需要先定义打包或递归语义。",
        parameters: {
          type: "object",
          properties: {
            from_path: { type: "string" },
            to_path: { type: "string" }
          },
          required: ["from_path", "to_path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileMutationPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_delete",
        description: "删除本地文件或整个目录；目录会递归删除。path 相对本地文件工作区根目录，也可传允许范围内的绝对路径。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileMutationPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_search",
        description: "搜索本地文件。mode=name（默认）按路径/文件名匹配；mode=content 在文本文件内容中查找，返回 path、line、text。limit 默认 50，超限时 truncated=true。先用它定位文件，再 filesystem_read 精读。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            mode: { type: "string", enum: ["name", "content"] }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileSearchPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_mkdir",
        description: "创建本地目录（含中间层，等同 mkdir -p）。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: localFileMutationPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "filesystem_send_to_chat",
        description: "发送本地文件到当前聊天。图片按图片发送；其他文件需要文件消息能力。不能附带 text。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled,
    resultObservation: fileSendPolicy()
  }
];

export const chatFileToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "asset_list",
        description: "列出或查找已登记 asset。优先传 asset_ref 或 asset_id 精确查找；也可用 query 按引用、ID、来源文件名、路径或 caption 模糊过滤，再按 kind/origin 缩小范围。默认不列出原始 chat_message 附件，除非 origin=chat_message。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" },
            query: { type: "string" },
            kind: { type: "string", enum: ["image", "animated_image", "video", "audio", "file"] },
            origin: { type: "string", enum: ["chat_message", "browser_download", "browser_screenshot", "comfy_generated", "group_file_download", "local_file_import", "user_upload"] },
            limit: { type: "integer", minimum: 1, maximum: 100 }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isChatFileToolEnabled,
    resultObservation: chatFileListPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "asset_send_to_chat",
        description: "发送已登记 asset 到当前聊天。优先用 asset_ref；其他文件需要文件消息能力。不能附带 text。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isChatFileToolEnabled,
    resultObservation: fileSendPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "asset_local_path",
        description: "获取已登记 asset 的本机存储路径。需要复制到本地目录时用 asset_export_to_filesystem。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" },
            absolute: { type: "boolean" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.chatFiles.enabled && config.localFiles.enabled,
    resultObservation: assetLocalPathPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "asset_export_to_filesystem",
        description: "复制已登记 asset 到本地文件路径或目录，不改原 asset。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" },
            to_path: { type: "string" }
          },
          required: ["to_path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.chatFiles.enabled && config.localFiles.enabled,
    resultObservation: localFileMutationPolicy()
  }
];

export const localFileToolHandlers: Record<string, ToolHandler> = {
  async filesystem_list(_toolCall, args, context) {
    const path = getStringArg(args, "path") || ".";
    const s = await context.localFileService.statItem(path);
    if (s.kind === "directory") {
      const limit = getNumberArg(args, "limit") ?? 200;
      const { root: _root, ...result } = await context.localFileService.listItems(path, limit);
      return JSON.stringify(result);
    }
    return JSON.stringify(buildLocalFileHandleResultFromContext(s, context));
  },

  async filesystem_read(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    const startLine = getNumberArg(args, "start_line");
    const endLine = getNumberArg(args, "end_line");
    const result = await context.localFileService.readFile(path, {
      ...(startLine ? { startLine } : {}),
      ...(endLine ? { endLine } : {})
    });
    return JSON.stringify(withNextActions(result as unknown as Record<string, unknown>, localFileReadNextActions(result)));
  },

  async filesystem_write(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    const content = typeof args === "object" && args && "content" in args
      ? String((args as Record<string, unknown>).content ?? "")
      : "";
    const mode = getStringArg(args, "mode") || "overwrite";
    return JSON.stringify(await context.localFileService.writeFile(path, content, mode as "overwrite" | "append" | "create"));
  },

  async filesystem_patch(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    const patch = typeof args === "object" && args && "patch" in args
      ? String((args as Record<string, unknown>).patch ?? "")
      : "";
    if (!path || !patch) {
      const oldText = typeof args === "object" && args && "old_text" in args
        ? String((args as Record<string, unknown>).old_text ?? "")
        : "";
      const hasNewText = typeof args === "object" && args && "new_text" in args;
      const newText = hasNewText ? String((args as Record<string, unknown>).new_text ?? "") : "";
      if (path && oldText && hasNewText) {
        return JSON.stringify(await context.localFileService.replaceFileText(path, oldText, newText));
      }
      return JSON.stringify({ error: "path and either patch or old_text/new_text are required" });
    }
    return JSON.stringify(await context.localFileService.patchFile(path, patch));
  },

  async filesystem_move(_toolCall, args, context) {
    const fromPath = getStringArg(args, "from_path");
    const toPath = getStringArg(args, "to_path");
    if (!fromPath || !toPath) {
      return JSON.stringify({ error: "from_path and to_path are required" });
    }
    return JSON.stringify(await context.localFileService.moveItem(fromPath, toPath));
  },

  async filesystem_copy(_toolCall, args, context) {
    const fromPath = getStringArg(args, "from_path");
    const toPath = getStringArg(args, "to_path");
    if (!fromPath || !toPath) {
      return JSON.stringify({ error: "from_path and to_path are required" });
    }
    return JSON.stringify(await context.localFileService.copyItem(fromPath, toPath));
  },

  async filesystem_delete(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    return JSON.stringify(await context.localFileService.deleteItem(path));
  },

  async filesystem_search(_toolCall, args, context) {
    const query = getStringArg(args, "query");
    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }
    const path = getStringArg(args, "path") || ".";
    const limit = clampInteger(getRawNumberArg(args, "limit"), 50, 1, 100);
    const mode = getStringArg(args, "mode") || "name";
    if (mode === "content") {
      const { root: _root, ...result } = await context.localFileService.findText(query, path, limit);
      return JSON.stringify(result);
    }
    const { root: _root, ...result } = await context.localFileService.searchItems(query, path, limit);
    return JSON.stringify(result);
  },

  async filesystem_mkdir(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    return JSON.stringify(await context.localFileService.mkdir(path));
  },

  async filesystem_send_to_chat(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    let resolvedPath;
    try {
      resolvedPath = resolveSendablePath(context.localFileService, path);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
    return sendResolvedPathToChat(context, resolvedPath, getStringArg(args, "text"));
  }
};

export const chatFileToolHandlers: Record<string, ToolHandler> = {
  async asset_list(_toolCall, args, context) {
    const selector = getStringArg(args, "asset_ref") || getStringArg(args, "asset_id");
    if (selector) {
      const file = await resolveChatFile(context, selector);
      const fileHandle = file ? buildChatFileHandleResultFromContext(file, context) : null;
      return JSON.stringify({
        ok: Boolean(file),
        file: fileHandle,
        ...(fileHandle ? { next_actions: fileHandle.next_actions ?? [] } : {})
      });
    }
    const kind = getStringArg(args, "kind");
    const origin = getStringArg(args, "origin") as ChatFileOrigin | null;
    const query = getStringArg(args, "query");
    const limit = clampInteger(getRawNumberArg(args, "limit"), 50, 1, 100);
    const normalizedQuery = String(query ?? "").trim().toLowerCase();
    const matchedFiles = (await context.chatFileStore.listFiles())
      .filter((item) => !kind || item.kind === kind)
      .filter((item) => origin ? item.origin === origin : item.origin !== "chat_message")
      .filter((item) => !normalizedQuery || chatFileMatchesQuery(item, normalizedQuery));
    const files = matchedFiles
      .slice(0, limit)
      .map((item) => buildChatFileHandleResultFromContext(item, context));
    return JSON.stringify({
      ok: true,
      files,
      totalMatched: matchedFiles.length,
      returned: files.length,
      truncated: matchedFiles.length > files.length,
      filters: {
        query: query ?? null,
        kind: kind ?? null,
        origin: origin ?? null,
        limit,
        defaultExcludedOrigin: origin ? null : "chat_message"
      }
    });
  },

  async asset_send_to_chat(_toolCall, args, context) {
    const selector = getStringArg(args, "asset_ref") || getStringArg(args, "asset_id");
    if (!selector) {
      return JSON.stringify({ error: "asset_ref or asset_id is required" });
    }
    const file = await resolveChatFile(context, selector);
    if (!file) {
      return JSON.stringify({ error: await buildUnknownAssetError(context, selector) });
    }
    return sendChatFileToChat(context, file, getStringArg(args, "text"));
  },

  async asset_local_path(_toolCall, args, context) {
    const selector = getStringArg(args, "asset_ref") || getStringArg(args, "asset_id");
    if (!selector) {
      return JSON.stringify({ error: "asset_ref or asset_id is required" });
    }
    const file = await resolveChatFile(context, selector);
    if (!file) {
      return JSON.stringify({ error: await buildUnknownAssetError(context, selector) });
    }
    const absolutePath = await context.chatFileStore.resolveAbsolutePath(file.fileId);
    const absolute = Boolean(typeof args === "object" && args && (args as Record<string, unknown>).absolute);
    return JSON.stringify({
      ok: true,
      asset_ref: file.fileRef,
      file_id: file.fileId,
      path: absolute ? absolutePath : file.chatFilePath,
      path_mode: absolute ? "absolute" : "asset_store_relative",
      path_role: "asset_store_internal_path",
      source_name: file.sourceName,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      usage_hints: assetInternalPathUsageHints()
    });
  },

  async asset_export_to_filesystem(_toolCall, args, context) {
    const selector = getStringArg(args, "asset_ref") || getStringArg(args, "asset_id");
    const toPath = getStringArg(args, "to_path");
    if (!selector || !toPath) {
      return JSON.stringify({ error: "asset_ref or asset_id and to_path are required" });
    }
    const file = await resolveChatFile(context, selector);
    if (!file) {
      return JSON.stringify({ error: await buildUnknownAssetError(context, selector) });
    }
    const sourceAbsolutePath = await context.chatFileStore.resolveAbsolutePath(file.fileId);
    const preliminaryDestination = context.localFileService.resolvePath(toPath);
    const targetIsExistingDirectory = await stat(preliminaryDestination.absolutePath)
      .then((item) => item.isDirectory())
      .catch(() => false);
    const destinationInput = targetIsExistingDirectory || toPath.endsWith("/") || toPath.endsWith("\\")
      ? `${toPath.replace(/[\\/]+$/, "")}/${sanitizeExportFileName(file)}`
      : toPath;
    const destination = context.localFileService.resolvePath(destinationInput);
    await mkdir(dirname(destination.absolutePath), { recursive: true });
    await copyFile(sourceAbsolutePath, destination.absolutePath);
    const copiedStat = await stat(destination.absolutePath);
    return JSON.stringify({
      ok: true,
      asset_ref: file.fileRef,
      file_id: file.fileId,
      from_path: file.chatFilePath,
      from_path_role: "asset_store_internal_path",
      to_path: destination.relativePath,
      to_path_role: "local_filesystem_path",
      usage_hints: assetInternalPathUsageHints(),
      size_bytes: copiedStat.size
    });
  }
};

function localFileReadNextActions(result: {
  path: string;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}): ToolNextAction[] {
  if (!result.truncated || result.endLine >= result.totalLines) {
    return [];
  }
  return [
    nextAction("filesystem_read", "继续读取剩余内容", {
      path: result.path,
      start_line: result.endLine + 1,
      end_line: result.totalLines
    })
  ];
}

function chatFileMatchesQuery(file: ChatFileRecord, normalizedQuery: string): boolean {
  const haystack = [
    file.fileRef,
    file.fileId,
    file.sourceName,
    file.chatFilePath,
    file.mimeType,
    file.caption,
    ...Object.values(file.sourceContext ?? {}).map((item) => String(item ?? ""))
  ].join("\n").toLowerCase();
  return haystack.includes(normalizedQuery);
}

function sanitizeExportFileName(file: ChatFileRecord): string {
  const candidates = [file.sourceName, file.fileRef, file.fileId];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim().replaceAll("\\", "/");
    const name = normalized.split("/").filter(Boolean).at(-1)?.trim();
    if (name && name !== "." && name !== "..") {
      return name;
    }
  }
  return "asset-file";
}

function getRawNumberArg(args: unknown, key: string): number | undefined {
  if (typeof args !== "object" || !args || !(key in args)) {
    return undefined;
  }
  const value = Number((args as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(candidate)));
}

async function sendResolvedPathToChat(
  context: Parameters<NonNullable<typeof localFileToolHandlers.filesystem_send_to_chat>>[2],
  resolvedPath: ReturnType<typeof resolveSendablePath>,
  text: string | null
) {
  const itemStat = await stat(resolvedPath.absolutePath);
  if (itemStat.isDirectory()) {
    // TODO: Define directory packaging before allowing filesystem_send_to_chat to send directories.
    return JSON.stringify({ error: "filesystem_send_to_chat does not support directories yet" });
  }
  const kind = inferSendableFileKind(resolvedPath.sourcePath);
  if (text) {
    return JSON.stringify({ error: "filesystem_send_to_chat 发送文件时不能附带 text；如需说明请另外发送文本" });
  }
  if (kind !== "image" && kind !== "animated_image") {
    return sendGenericFileToChat(context, {
      absolutePath: resolvedPath.absolutePath,
      previewText: resolvedPath.sourcePath,
      sourceName: resolvedPath.sourceName,
      fileId: null,
      fileRef: null,
      chatFilePath: resolvedPath.chatFilePath,
      sourcePath: resolvedPath.sourcePath,
      mimeType: null,
      sizeBytes: itemStat.size,
      toolName: "filesystem_send_to_chat",
      outputExtras: {
        path: resolvedPath.sourcePath,
        path_mode: resolvedPath.pathMode
      }
    });
  }

  return sendImageBytesToChat(context, {
    absolutePath: resolvedPath.absolutePath,
    previewText: resolvedPath.sourcePath,
    sourceName: resolvedPath.sourceName,
    fileId: null,
    fileRef: null,
    chatFilePath: resolvedPath.chatFilePath,
    sourcePath: resolvedPath.sourcePath,
    toolName: "filesystem_send_to_chat",
    outputExtras: {
      path_mode: resolvedPath.pathMode
    }
  });
}

async function sendChatFileToChat(
  context: Parameters<NonNullable<typeof localFileToolHandlers.filesystem_send_to_chat>>[2],
  file: ChatFileRecord,
  text: string | null
) {
  if (text) {
    return JSON.stringify({ error: "asset_send_to_chat 发送文件时不能附带 text；如需说明请另外发送文本" });
  }
  if (file.kind !== "image" && file.kind !== "animated_image") {
    return sendGenericFileToChat(context, {
      absolutePath: await context.chatFileStore.resolveAbsolutePath(file.fileId),
      previewText: file.fileRef,
      sourceName: file.sourceName,
      fileId: file.fileId,
      fileRef: file.fileRef,
      chatFilePath: file.chatFilePath,
      sourcePath: null,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      toolName: "asset_send_to_chat",
      outputExtras: {
        asset_ref: file.fileRef,
        file_id: file.fileId
      }
    });
  }

  return sendImageBytesToChat(context, {
    absolutePath: await context.chatFileStore.resolveAbsolutePath(file.fileId),
    previewText: file.fileRef,
    sourceName: file.sourceName,
    fileId: file.fileId,
    fileRef: file.fileRef,
    chatFilePath: file.chatFilePath,
    sourcePath: null,
    toolName: "asset_send_to_chat",
    outputExtras: {}
  });
}

async function sendGenericFileToChat(
  context: Parameters<NonNullable<typeof localFileToolHandlers.filesystem_send_to_chat>>[2],
  input: {
    absolutePath: string;
    previewText: string;
    sourceName: string | null;
    fileId: string | null;
    fileRef: string | null;
    chatFilePath: string | null;
    sourcePath: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    toolName: "filesystem_send_to_chat" | "asset_send_to_chat";
    outputExtras: Record<string, string | number>;
  }
) {
  const target = context.replyDelivery === "web" ? null : parseSessionTarget(context.lastMessage.sessionId);
  if (context.replyDelivery !== "web" && !target) {
    return JSON.stringify({ error: `unsupported session target: ${context.lastMessage.sessionId}` });
  }
  if (context.replyDelivery !== "web" && context.config.onebot.provider !== "napcat") {
    return JSON.stringify({
      error: "filesystem/asset file sending requires onebot.provider=napcat for non-image files",
      deliveredAs: "unsupported"
    });
  }

  enqueueToolSend(context, input.previewText, async () => {
    if (context.replyDelivery === "web") {
      context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "web",
        mediaKind: "file",
        fileId: input.fileId,
        fileRef: input.fileRef,
        sourceName: input.sourceName,
        chatFilePath: input.chatFilePath,
        sourcePath: input.sourcePath,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        messageId: null,
        toolName: input.toolName,
        captionText: null,
        timestampMs: Date.now()
      });
      return;
    }

    if (!target) {
      throw new Error(`unsupported session target: ${context.lastMessage.sessionId}`);
    }
    const payload = await context.oneBotClient.sendFile({
      ...target,
      filePath: input.absolutePath,
      name: input.sourceName
    });
    const messageId = recordDeliveredMessage(context, input.previewText, payload.data?.message_id);
    context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
      kind: "outbound_media_message",
      llmVisible: false,
      role: "assistant",
      delivery: "onebot",
      mediaKind: "file",
      fileId: input.fileId,
      fileRef: input.fileRef,
      sourceName: input.sourceName,
      chatFilePath: input.chatFilePath,
      sourcePath: input.sourcePath,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      messageId,
      toolName: input.toolName,
      captionText: null,
      timestampMs: Date.now()
    });
  });

  return {
    content: JSON.stringify({
      ok: true,
      ...input.outputExtras,
      deliveredAs: "file",
      queued: true
    })
  };
}

async function sendImageBytesToChat(
  context: Parameters<NonNullable<typeof localFileToolHandlers.filesystem_send_to_chat>>[2],
  input: {
    absolutePath: string;
    previewText: string;
    sourceName: string | null;
    fileId: string | null;
    fileRef: string | null;
    chatFilePath: string | null;
    sourcePath: string | null;
    toolName: "filesystem_send_to_chat" | "asset_send_to_chat";
    outputExtras: Record<string, string>;
  }
) {
  const target = context.replyDelivery === "web" ? null : parseSessionTarget(context.lastMessage.sessionId);
  if (context.replyDelivery !== "web" && !target) {
    return JSON.stringify({ error: `unsupported session target: ${context.lastMessage.sessionId}` });
  }
  const bytes = await readFile(input.absolutePath);
  const segments: OneBotMessageSegment[] = [{ type: "image", data: { file: `base64://${bytes.toString("base64")}` } }];
  enqueueToolSend(context, input.previewText, async () => {
    if (context.replyDelivery === "web") {
      context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "web",
        mediaKind: "image",
        fileId: input.fileId,
        fileRef: input.fileRef,
        sourceName: input.sourceName,
        chatFilePath: input.chatFilePath,
        sourcePath: input.sourcePath,
        messageId: null,
        toolName: input.toolName,
        captionText: null,
        timestampMs: Date.now()
      });
      return;
    }

    if (!target) {
      throw new Error(`unsupported session target: ${context.lastMessage.sessionId}`);
    }
    const payload = await context.oneBotClient.sendMessage({ ...target, message: segments });
    const messageId = recordDeliveredMessage(context, input.previewText, payload.data?.message_id);
    context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
      kind: "outbound_media_message",
      llmVisible: false,
      role: "assistant",
      delivery: "onebot",
      mediaKind: "image",
      fileId: input.fileId,
      fileRef: input.fileRef,
      sourceName: input.sourceName,
      chatFilePath: input.chatFilePath,
      sourcePath: input.sourcePath,
      messageId,
      toolName: input.toolName,
      captionText: null,
      timestampMs: Date.now()
    });
  });
  return {
    content: JSON.stringify({
      ok: true,
      ...(input.fileRef ? { asset_ref: input.fileRef } : {}),
      ...(input.fileId ? { file_id: input.fileId } : {}),
      ...(input.sourcePath ? { path: input.sourcePath } : {}),
      ...input.outputExtras,
      deliveredAs: "image",
      queued: true
    })
  };
}

function recordDeliveredMessage(
  context: Parameters<NonNullable<typeof localFileToolHandlers.filesystem_send_to_chat>>[2],
  text: string,
  messageIdValue: unknown
): number | null {
  const messageId = normalizeOneBotMessageId(messageIdValue);
  if (messageId == null) {
    return null;
  }
  context.sessionManager.recordSentMessage(context.lastMessage.sessionId, {
    messageId,
    text,
    sentAt: Date.now()
  });
  return messageId;
}

async function buildUnknownAssetError(
  context: Parameters<NonNullable<typeof localFileToolHandlers.filesystem_send_to_chat>>[2],
  requestedAssetRef: string
): Promise<string> {
  const normalized = String(requestedAssetRef ?? "").trim();
  if (!normalized) {
    return "unknown asset";
  }
  const files = await context.chatFileStore.listFiles().catch(() => []);
  const matched = files.find((item) => (
    item.fileRef === normalized
    || item.fileId === normalized
    || item.sourceName === normalized
    || item.chatFilePath.split("/").at(-1) === normalized
  ));
  if (matched) {
    return `unknown asset: ${normalized}; use asset_ref=${matched.fileRef} or asset_id=${matched.fileId}`;
  }
  return `unknown asset: ${normalized}`;
}

async function resolveChatFile(
  context: Parameters<NonNullable<typeof localFileToolHandlers.filesystem_send_to_chat>>[2],
  fileSelector: string
) {
  const normalized = String(fileSelector ?? "").trim();
  if (!normalized) {
    return null;
  }
  const direct = await context.chatFileStore.getFile(normalized);
  if (direct) {
    return direct;
  }
  const files = await context.chatFileStore.listFiles().catch(() => []);
  return files.find((item) => (
    item.fileRef === normalized
    || item.sourceName === normalized
    || item.chatFilePath.split("/").at(-1) === normalized
  )) ?? null;
}

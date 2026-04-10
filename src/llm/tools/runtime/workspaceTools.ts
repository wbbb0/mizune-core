import { readFile } from "node:fs/promises";
import type { OneBotMessageSegment } from "#services/onebot/types.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import { inferSendableFileKind, resolveSendablePath } from "#services/workspace/sendablePath.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { mapWorkspaceFileToView } from "../core/workspaceFileView.ts";

const isWorkspaceToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.workspace.enabled;

function parseSessionTarget(sessionId: string): { userId?: string; groupId?: string } | null {
  if (sessionId.startsWith("private:")) {
    return { userId: sessionId.slice("private:".length) };
  }
  if (sessionId.startsWith("group:")) {
    return { groupId: sessionId.slice("group:".length) };
  }
  return null;
}

function enqueueToolSend(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_file_to_chat>>[2],
  previewText: string,
  send: () => Promise<void>
): void {
  context.messageQueue.enqueueTextDetached({
    sessionId: context.lastMessage.sessionId,
    text: previewText,
    send
  });
}

function resolveToolDelivery(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_file_to_chat>>[2]
): "onebot" | "web" {
  return context.replyDelivery;
}

function buildAssistantHistoryTarget(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_file_to_chat>>[2]
): {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
} {
  return {
    chatType: context.lastMessage.sessionId.startsWith("group:") ? "group" : "private",
    userId: context.lastMessage.userId,
    senderName: context.lastMessage.senderName
  };
}

export const workspaceToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "list_workspace_items",
        description: "列出当前实例 data workspace 下某个相对目录的文件和子目录。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "stat_workspace_item",
        description: "查看 workspace 中单个文件或目录的元数据。",
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
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "read_workspace_file",
        description: "读取 workspace 下的文本文件，可选按行范围截取。",
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
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "write_workspace_file",
        description: "写入 workspace 文本文件。mode 支持 overwrite、append、create。",
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
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "patch_workspace_file",
        description: "用 unified diff hunk patch 修改 workspace 中的文本文件。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            patch: { type: "string" }
          },
          required: ["path", "patch"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "mkdir_workspace_dir",
        description: "在 workspace 中创建目录。",
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
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "move_workspace_item",
        description: "移动或重命名 workspace 下的文件或目录。",
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
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "delete_workspace_item",
        description: "删除 workspace 下的文件或目录。",
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
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "list_workspace_files",
        description: "列出当前工作区已保存的 workspace file。workspace file 是已落盘的图片、视频、音频或文件，不是 browser/shell live_resource。",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["image", "animated_image", "video", "audio", "file"]
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100
            }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isWorkspaceToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "send_workspace_file_to_chat",
        description: "把文件发送回当前聊天。发送已登记的 workspace file 时优先传 file_ref，file_id 只是稳定主键；按路径直接发送时传 path。path 在 shell.allowAnyCwd=true 时必须是绝对路径，在 false 时必须是 workspace 相对路径。图片会原生发送，其他文件暂时会降级为说明文本。",
        parameters: {
          type: "object",
          properties: {
            file_ref: { type: "string" },
            file_id: { type: "string" },
            path: { type: "string" },
            text: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isWorkspaceToolEnabled
  }
];

export const workspaceToolHandlers: Record<string, ToolHandler> = {
  async list_workspace_items(_toolCall, args, context) {
    return JSON.stringify(await context.workspaceService.listItems(getStringArg(args, "path") || "."));
  },

  async stat_workspace_item(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    return JSON.stringify(await context.workspaceService.statItem(path));
  },

  async read_workspace_file(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    const startLine = getNumberArg(args, "start_line");
    const endLine = getNumberArg(args, "end_line");
    return JSON.stringify(await context.workspaceService.readFile(path, {
      ...(startLine ? { startLine } : {}),
      ...(endLine ? { endLine } : {})
    }));
  },

  async write_workspace_file(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    const content = typeof args === "object" && args && "content" in args
      ? String((args as Record<string, unknown>).content ?? "")
      : "";
    const mode = getStringArg(args, "mode") || "overwrite";
    return JSON.stringify(await context.workspaceService.writeFile(path, content, mode as "overwrite" | "append" | "create"));
  },

  async patch_workspace_file(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    const patch = typeof args === "object" && args && "patch" in args
      ? String((args as Record<string, unknown>).patch ?? "")
      : "";
    if (!path || !patch) {
      return JSON.stringify({ error: "path and patch are required" });
    }
    return JSON.stringify(await context.workspaceService.patchFile(path, patch));
  },

  async mkdir_workspace_dir(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    return JSON.stringify(await context.workspaceService.mkdir(path));
  },

  async move_workspace_item(_toolCall, args, context) {
    const fromPath = getStringArg(args, "from_path");
    const toPath = getStringArg(args, "to_path");
    if (!fromPath || !toPath) {
      return JSON.stringify({ error: "from_path and to_path are required" });
    }
    return JSON.stringify(await context.workspaceService.moveItem(fromPath, toPath));
  },

  async delete_workspace_item(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    return JSON.stringify(await context.workspaceService.deleteItem(path));
  },

  async list_workspace_files(_toolCall, args, context) {
    const kind = getStringArg(args, "kind");
    const limit = getNumberArg(args, "limit");
    const files = (await context.mediaWorkspace.listFiles())
      .filter((item) => !kind || item.kind === kind)
      .slice(0, limit ?? 50)
      .map((item) => mapWorkspaceFileToView(item));
    return JSON.stringify({
      ok: true,
      files
    });
  },

  async send_workspace_file_to_chat(_toolCall, args, context) {
    const fileRef = getStringArg(args, "file_ref") || getStringArg(args, "file_id");
    const path = getStringArg(args, "path");
    if (!fileRef && !path) {
      return JSON.stringify({ error: "file_ref, file_id, or path is required" });
    }
    if (fileRef && path) {
      return JSON.stringify({ error: "file_ref/file_id and path are mutually exclusive" });
    }
    let file = null;
    let directPathInfo: ReturnType<typeof resolveDirectPathSendInput> | null = null;
    if (path) {
      try {
        directPathInfo = resolveDirectPathSendInput(context, path);
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      file = await resolveWorkspaceFile(context, fileRef!);
      if (!file) {
        return JSON.stringify({ error: await buildUnknownAssetError(context, fileRef!) });
      }
    }
    const target = parseSessionTarget(context.lastMessage.sessionId);
    if (!target) {
      return JSON.stringify({ error: `Unsupported session target: ${context.lastMessage.sessionId}` });
    }
    const delivery = resolveToolDelivery(context);
    const text = getStringArg(args, "text");
    const kind = directPathInfo?.kind ?? file?.kind ?? "file";
    if (kind !== "image" && kind !== "animated_image") {
      const summary = text || buildNonImageSendSummary(file, directPathInfo);
      enqueueToolSend(context, summary, async () => {
        if (delivery === "web") {
          await context.webOutputCollector?.append(summary);
          context.sessionManager.appendAssistantHistory(context.lastMessage.sessionId, {
            ...buildAssistantHistoryTarget(context),
            text: summary
          });
          return;
        }

        const payload = await context.oneBotClient.sendText({
          ...target,
          text: summary
        });
        recordDeliveredMessage(context, summary, payload.data?.message_id);
      });
      return {
        content: JSON.stringify({
          ok: true,
          ...(file ? {
            file_ref: file.fileRef,
            file_id: file.fileId
          } : {}),
          ...(directPathInfo ? {
            path: directPathInfo.sourcePath,
            path_mode: directPathInfo.pathMode,
            source_name: directPathInfo.sourceName
          } : {}),
          deliveredAs: "text_fallback",
          queued: true,
          reason: "native file sending is not enabled in this phase"
        })
      };
    }
    if (text) {
      return JSON.stringify({ error: "send_workspace_file_to_chat 发送图片时不能附带 text；若需要文字，请让模型单独发送回复" });
    }
    const absolutePath = directPathInfo?.absolutePath ?? await context.mediaWorkspace.resolveAbsolutePath(file!.fileId);
    const bytes = await readFile(absolutePath);
    const segments: OneBotMessageSegment[] = [
      { type: "image", data: { file: `base64://${bytes.toString("base64")}` } }
    ];
    const previewText = directPathInfo?.sourcePath ?? file?.fileRef ?? file?.sourceName ?? file?.fileId ?? "image";
    enqueueToolSend(context, previewText, async () => {
      if (delivery === "web") {
        context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
          kind: "outbound_media_message",
          llmVisible: false,
          role: "assistant",
          delivery: "web",
          mediaKind: "image",
          fileId: file?.fileId ?? null,
          fileRef: file?.fileRef ?? null,
          sourceName: directPathInfo?.sourceName ?? file?.sourceName ?? null,
          workspacePath: directPathInfo?.workspacePath ?? file?.workspacePath ?? null,
          sourcePath: directPathInfo?.sourcePath ?? null,
          messageId: null,
          toolName: "send_workspace_file_to_chat",
          captionText: null,
          timestampMs: Date.now()
        });
        return;
      }

      const payload = await context.oneBotClient.sendMessage({
        ...target,
        message: segments
      });
      const messageId = recordDeliveredMessage(context, previewText, payload.data?.message_id);
      context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "onebot",
        mediaKind: "image",
        fileId: file?.fileId ?? null,
        fileRef: file?.fileRef ?? null,
        sourceName: directPathInfo?.sourceName ?? file?.sourceName ?? null,
        workspacePath: directPathInfo?.workspacePath ?? file?.workspacePath ?? null,
        sourcePath: directPathInfo?.sourcePath ?? null,
        messageId,
        toolName: "send_workspace_file_to_chat",
        captionText: null,
        timestampMs: Date.now()
      });
    });
    return {
      content: JSON.stringify({
        ok: true,
        ...(file ? {
          file_ref: file.fileRef,
          file_id: file.fileId
        } : {}),
        ...(directPathInfo ? {
          path: directPathInfo.sourcePath,
          path_mode: directPathInfo.pathMode,
          source_name: directPathInfo.sourceName
        } : {}),
        deliveredAs: "image",
        queued: true
      })
    };
  }
};

function recordDeliveredMessage(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_file_to_chat>>[2],
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
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_file_to_chat>>[2],
  requestedAssetRef: string
): Promise<string> {
  const normalized = String(requestedAssetRef ?? "").trim();
  if (!normalized) {
    return "Unknown workspace file";
  }

  const files = await context.mediaWorkspace.listFiles().catch(() => []);
  const matchedByDisplayName = files.find((item) => item.fileRef === normalized);
  if (matchedByDisplayName) {
    return [
      `Unknown workspace file: ${normalized}`,
      `received file_ref display name; use file_ref=${matchedByDisplayName.fileRef} or file_id=${matchedByDisplayName.fileId}`
    ].join("; ");
  }
  const matchedByStoredFilename = files.find((item) => item.workspacePath.split("/").at(-1) === normalized);
  if (matchedByStoredFilename) {
    return [
      `Unknown workspace file: ${normalized}`,
      `received storage filename; use file_ref=${matchedByStoredFilename.fileRef} or file_id=${matchedByStoredFilename.fileId}`
    ].join("; ");
  }

  const matchedByFilename = files.find((item) => item.sourceName === normalized);
  if (matchedByFilename) {
    return [
      `Unknown workspace file: ${normalized}`,
      `received source filename; use file_ref=${matchedByFilename.fileRef} or file_id=${matchedByFilename.fileId}`
    ].join("; ");
  }

  return `${"Unknown workspace file: "}${normalized}. 直接用 file_ref；若系统同时给了 file_id，file_id 是稳定主键。`;
}

async function resolveWorkspaceFile(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_file_to_chat>>[2],
  fileSelector: string
) {
  const normalized = String(fileSelector ?? "").trim();
  if (!normalized) {
    return null;
  }
  const direct = await context.mediaWorkspace.getFile(normalized);
  if (direct) {
    return direct;
  }
  const files = await context.mediaWorkspace.listFiles().catch(() => []);
  return files.find((item) => (
    item.fileRef === normalized
    || item.workspacePath.split("/").at(-1) === normalized
    || item.sourceName === normalized
  )) ?? null;
}

function resolveDirectPathSendInput(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_file_to_chat>>[2],
  inputPath: string
): {
  absolutePath: string;
  sourceName: string;
  sourcePath: string;
  pathMode: "absolute" | "workspace_relative";
  workspacePath: string | null;
  kind: "image" | "animated_image" | "file";
} {
  const resolvedPath = resolveSendablePath(context.config, context.workspaceService, inputPath);
  return {
    ...resolvedPath,
    kind: inferSendableFileKind(resolvedPath.sourcePath)
  };
}

function buildNonImageSendSummary(
  file: Awaited<ReturnType<typeof resolveWorkspaceFile>>,
  directPathInfo: ReturnType<typeof resolveDirectPathSendInput> | null
): string {
  if (file) {
    return `文件已保存在工作区：${file.fileRef}；file_id=${file.fileId}`;
  }
  if (!directPathInfo) {
    return "文件已发送";
  }
  return directPathInfo.pathMode === "absolute"
    ? `文件已发送：${directPathInfo.sourcePath}`
    : `工作区文件已发送：${directPathInfo.sourcePath}`;
}

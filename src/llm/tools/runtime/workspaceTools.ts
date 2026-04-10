import { readFile } from "node:fs/promises";
import type { ChatFileOrigin, ChatFileRecord } from "#services/workspace/types.ts";
import type { OneBotMessageSegment } from "#services/onebot/types.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import { inferSendableFileKind, resolveSendablePath } from "#services/workspace/sendablePath.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { mapWorkspaceFileToView } from "../core/workspaceFileView.ts";

const isLocalFileToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.localFiles.enabled;
const isChatFileToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.chatFiles.enabled;

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
  context: Parameters<NonNullable<typeof localFileToolHandlers.local_file_send_to_chat>>[2],
  previewText: string,
  send: () => Promise<void>
): void {
  context.messageQueue.enqueueTextDetached({
    sessionId: context.lastMessage.sessionId,
    text: previewText,
    send
  });
}

function buildAssistantHistoryTarget(
  context: Parameters<NonNullable<typeof localFileToolHandlers.local_file_send_to_chat>>[2]
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

export const localFileToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_list_items",
        description: "列出本地文件根目录下某个相对目录。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_stat",
        description: "查看单个本地文件或目录。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_read",
        description: "读取本地文本文件，可按行截取。",
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
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_write",
        description: "写入本地文本文件。",
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
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_patch",
        description: "用 unified diff patch 修改本地文本文件。",
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
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_mkdir",
        description: "创建本地目录。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_move",
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
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_delete",
        description: "删除本地文件或目录。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_search_items",
        description: "按名称搜索本地文件或目录。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200 }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_find_text",
        description: "在本地文本文件里查找文本。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200 }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_send_to_chat",
        description: "按路径发送本地文件到当前聊天。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            text: { type: "string" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isLocalFileToolEnabled
  }
];

export const chatFileToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "chat_file_list",
        description: "列出已登记的 chat file。",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["image", "animated_image", "video", "audio", "file"] },
            origin: { type: "string", enum: ["chat_message", "browser_download", "browser_screenshot", "comfy_generated", "local_file_import", "user_upload"] },
            limit: { type: "integer", minimum: 1, maximum: 100 }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isChatFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "chat_file_get",
        description: "查看单个 chat file。",
        parameters: {
          type: "object",
          properties: {
            file_ref: { type: "string" },
            file_id: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isChatFileToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "chat_file_send_to_chat",
        description: "发送已登记的 chat file 到当前聊天。",
        parameters: {
          type: "object",
          properties: {
            file_ref: { type: "string" },
            file_id: { type: "string" },
            text: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isChatFileToolEnabled
  }
];

export const localFileToolHandlers: Record<string, ToolHandler> = {
  async local_file_list_items(_toolCall, args, context) {
    return JSON.stringify(await context.localFileService.listItems(getStringArg(args, "path") || "."));
  },

  async local_file_stat(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    return JSON.stringify(await context.localFileService.statItem(path));
  },

  async local_file_read(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    const startLine = getNumberArg(args, "start_line");
    const endLine = getNumberArg(args, "end_line");
    return JSON.stringify(await context.localFileService.readFile(path, {
      ...(startLine ? { startLine } : {}),
      ...(endLine ? { endLine } : {})
    }));
  },

  async local_file_write(_toolCall, args, context) {
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

  async local_file_patch(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    const patch = typeof args === "object" && args && "patch" in args
      ? String((args as Record<string, unknown>).patch ?? "")
      : "";
    if (!path || !patch) {
      return JSON.stringify({ error: "path and patch are required" });
    }
    return JSON.stringify(await context.localFileService.patchFile(path, patch));
  },

  async local_file_mkdir(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    return JSON.stringify(await context.localFileService.mkdir(path));
  },

  async local_file_move(_toolCall, args, context) {
    const fromPath = getStringArg(args, "from_path");
    const toPath = getStringArg(args, "to_path");
    if (!fromPath || !toPath) {
      return JSON.stringify({ error: "from_path and to_path are required" });
    }
    return JSON.stringify(await context.localFileService.moveItem(fromPath, toPath));
  },

  async local_file_delete(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    return JSON.stringify(await context.localFileService.deleteItem(path));
  },

  async local_file_search_items(_toolCall, args, context) {
    const query = getStringArg(args, "query");
    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }
    const path = getStringArg(args, "path") || ".";
    const limit = getNumberArg(args, "limit") ?? 50;
    return JSON.stringify(await context.localFileService.searchItems(query, path, limit));
  },

  async local_file_find_text(_toolCall, args, context) {
    const query = getStringArg(args, "query");
    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }
    const path = getStringArg(args, "path") || ".";
    const limit = getNumberArg(args, "limit") ?? 50;
    return JSON.stringify(await context.localFileService.findText(query, path, limit));
  },

  async local_file_send_to_chat(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    let resolvedPath;
    try {
      resolvedPath = resolveSendablePath(context.config, context.localFileService, path);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
    return sendResolvedPathToChat(context, resolvedPath, getStringArg(args, "text"));
  }
};

export const chatFileToolHandlers: Record<string, ToolHandler> = {
  async chat_file_list(_toolCall, args, context) {
    const kind = getStringArg(args, "kind");
    const origin = getStringArg(args, "origin") as ChatFileOrigin | null;
    const limit = getNumberArg(args, "limit") ?? 50;
    const files = (await context.chatFileStore.listFiles())
      .filter((item) => !kind || item.kind === kind)
      .filter((item) => origin ? item.origin === origin : item.origin !== "chat_message")
      .slice(0, limit)
      .map((item) => mapWorkspaceFileToView(item));
    return JSON.stringify({ ok: true, files });
  },

  async chat_file_get(_toolCall, args, context) {
    const selector = getStringArg(args, "file_ref") || getStringArg(args, "file_id");
    if (!selector) {
      return JSON.stringify({ error: "file_ref or file_id is required" });
    }
    const file = await resolveChatFile(context, selector);
    return JSON.stringify({
      ok: Boolean(file),
      file: file ? mapWorkspaceFileToView(file) : null
    });
  },

  async chat_file_send_to_chat(_toolCall, args, context) {
    const selector = getStringArg(args, "file_ref") || getStringArg(args, "file_id");
    if (!selector) {
      return JSON.stringify({ error: "file_ref or file_id is required" });
    }
    const file = await resolveChatFile(context, selector);
    if (!file) {
      return JSON.stringify({ error: await buildUnknownAssetError(context, selector) });
    }
    return sendChatFileToChat(context, file, getStringArg(args, "text"));
  }
};

async function sendResolvedPathToChat(
  context: Parameters<NonNullable<typeof localFileToolHandlers.local_file_send_to_chat>>[2],
  resolvedPath: ReturnType<typeof resolveSendablePath>,
  text: string | null
) {
  const target = parseSessionTarget(context.lastMessage.sessionId);
  if (!target) {
    return JSON.stringify({ error: `unsupported session target: ${context.lastMessage.sessionId}` });
  }
  const kind = inferSendableFileKind(resolvedPath.sourcePath);
  if (kind !== "image" && kind !== "animated_image") {
    const summary = text || (resolvedPath.pathMode === "absolute"
      ? `文件已发送：${resolvedPath.sourcePath}`
      : `本地文件已发送：${resolvedPath.sourcePath}`);
    enqueueToolSend(context, summary, async () => {
      if (context.replyDelivery === "web") {
        await context.webOutputCollector?.append(summary);
        context.sessionManager.appendAssistantHistory(context.lastMessage.sessionId, {
          ...buildAssistantHistoryTarget(context),
          text: summary
        });
        return;
      }
      const payload = await context.oneBotClient.sendText({ ...target, text: summary });
      recordDeliveredMessage(context, summary, payload.data?.message_id);
    });
    return {
      content: JSON.stringify({
        ok: true,
        path: resolvedPath.sourcePath,
        path_mode: resolvedPath.pathMode,
        deliveredAs: "text_fallback",
        queued: true
      })
    };
  }

  if (text) {
    return JSON.stringify({ error: "local_file_send_to_chat 发送图片时不能附带 text" });
  }
  return sendImageBytesToChat(context, {
    absolutePath: resolvedPath.absolutePath,
    previewText: resolvedPath.sourcePath,
    sourceName: resolvedPath.sourceName,
    fileId: null,
    fileRef: null,
    chatFilePath: resolvedPath.chatFilePath,
    sourcePath: resolvedPath.sourcePath,
    toolName: "local_file_send_to_chat",
    outputExtras: {
      path_mode: resolvedPath.pathMode
    }
  });
}

async function sendChatFileToChat(
  context: Parameters<NonNullable<typeof localFileToolHandlers.local_file_send_to_chat>>[2],
  file: ChatFileRecord,
  text: string | null
) {
  if (file.kind !== "image" && file.kind !== "animated_image") {
    const summary = text || `chat file 已发送：${file.fileRef}；file_id=${file.fileId}`;
    const target = parseSessionTarget(context.lastMessage.sessionId);
    if (!target) {
      return JSON.stringify({ error: `unsupported session target: ${context.lastMessage.sessionId}` });
    }
    enqueueToolSend(context, summary, async () => {
      if (context.replyDelivery === "web") {
        await context.webOutputCollector?.append(summary);
        context.sessionManager.appendAssistantHistory(context.lastMessage.sessionId, {
          ...buildAssistantHistoryTarget(context),
          text: summary
        });
        return;
      }
      const payload = await context.oneBotClient.sendText({ ...target, text: summary });
      recordDeliveredMessage(context, summary, payload.data?.message_id);
    });
    return {
      content: JSON.stringify({
        ok: true,
        file_ref: file.fileRef,
        file_id: file.fileId,
        deliveredAs: "text_fallback",
        queued: true
      })
    };
  }

  if (text) {
    return JSON.stringify({ error: "chat_file_send_to_chat 发送图片时不能附带 text" });
  }
  return sendImageBytesToChat(context, {
    absolutePath: await context.chatFileStore.resolveAbsolutePath(file.fileId),
    previewText: file.fileRef,
    sourceName: file.sourceName,
    fileId: file.fileId,
    fileRef: file.fileRef,
    chatFilePath: file.chatFilePath,
    sourcePath: null,
    toolName: "chat_file_send_to_chat",
    outputExtras: {}
  });
}

async function sendImageBytesToChat(
  context: Parameters<NonNullable<typeof localFileToolHandlers.local_file_send_to_chat>>[2],
  input: {
    absolutePath: string;
    previewText: string;
    sourceName: string | null;
    fileId: string | null;
    fileRef: string | null;
    chatFilePath: string | null;
    sourcePath: string | null;
    toolName: "local_file_send_to_chat" | "chat_file_send_to_chat";
    outputExtras: Record<string, string>;
  }
) {
  const target = parseSessionTarget(context.lastMessage.sessionId);
  if (!target) {
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
      ...(input.fileRef ? { file_ref: input.fileRef } : {}),
      ...(input.fileId ? { file_id: input.fileId } : {}),
      ...(input.sourcePath ? { path: input.sourcePath } : {}),
      ...input.outputExtras,
      deliveredAs: "image",
      queued: true
    })
  };
}

function recordDeliveredMessage(
  context: Parameters<NonNullable<typeof localFileToolHandlers.local_file_send_to_chat>>[2],
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
  context: Parameters<NonNullable<typeof localFileToolHandlers.local_file_send_to_chat>>[2],
  requestedAssetRef: string
): Promise<string> {
  const normalized = String(requestedAssetRef ?? "").trim();
  if (!normalized) {
    return "unknown chat file";
  }
  const files = await context.chatFileStore.listFiles().catch(() => []);
  const matched = files.find((item) => (
    item.fileRef === normalized
    || item.fileId === normalized
    || item.sourceName === normalized
    || item.chatFilePath.split("/").at(-1) === normalized
  ));
  if (matched) {
    return `unknown chat file: ${normalized}; use file_ref=${matched.fileRef} or file_id=${matched.fileId}`;
  }
  return `unknown chat file: ${normalized}`;
}

async function resolveChatFile(
  context: Parameters<NonNullable<typeof localFileToolHandlers.local_file_send_to_chat>>[2],
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

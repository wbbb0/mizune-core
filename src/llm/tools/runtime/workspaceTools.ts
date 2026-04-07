import { readFile } from "node:fs/promises";
import type { OneBotMessageSegment } from "#services/onebot/types.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";

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
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_media_to_chat>>[2],
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
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_media_to_chat>>[2]
): "onebot" | "web" {
  return context.outboundDelivery
    ?? context.sessionManager?.getLastInboundDelivery?.(context.lastMessage.sessionId)
    ?? "onebot";
}

function buildAssistantHistoryTarget(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_media_to_chat>>[2]
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
        name: "send_workspace_media_to_chat",
        description: "把 workspace 中的图片发送回当前聊天。asset_ref 可直接填系统返回的短名，如 comfy_ab12cd34.png；也可填 asset_id。关系很简单：asset_ref 是给你看的短引用，asset_id 是稳定主键。文件暂不保证原生发送，会降级为说明文本。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" }
          },
          required: ["asset_ref"],
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

  async send_workspace_media_to_chat(_toolCall, args, context) {
    const assetRef = getStringArg(args, "asset_ref") || getStringArg(args, "asset_id");
    if (!assetRef) {
      return JSON.stringify({ error: "asset_ref is required" });
    }
    const asset = await resolveWorkspaceAsset(context, assetRef);
    if (!asset) {
      return JSON.stringify({ error: await buildUnknownAssetError(context, assetRef) });
    }
    const target = parseSessionTarget(context.lastMessage.sessionId);
    if (!target) {
      return JSON.stringify({ error: `Unsupported session target: ${context.lastMessage.sessionId}` });
    }
    const delivery = resolveToolDelivery(context);
    const text = getStringArg(args, "text");
    if (asset.kind !== "image" && asset.kind !== "animated_image") {
      const summary = text || `文件已保存在工作区：${asset.displayName}；asset_id=${asset.assetId}`;
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
          assetRef: asset.displayName,
          assetId: asset.assetId,
          deliveredAs: "text_fallback",
          queued: true,
          reason: "native file sending is not enabled in this phase"
        })
      };
    }
    if (text) {
      return JSON.stringify({ error: "send_workspace_media_to_chat 发送图片时不能附带 text；若需要文字，请让模型单独发送回复" });
    }
    const absolutePath = await context.mediaWorkspace.resolveAbsolutePath(asset.assetId);
    const bytes = await readFile(absolutePath);
    const segments: OneBotMessageSegment[] = [
      { type: "image", data: { file: `base64://${bytes.toString("base64")}` } }
    ];
    enqueueToolSend(context, asset.displayName || asset.filename || asset.assetId, async () => {
      if (delivery === "web") {
        context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
          kind: "outbound_media_message",
          llmVisible: false,
          role: "assistant",
          delivery: "web",
          mediaKind: "image",
          assetId: asset.assetId,
          filename: asset.filename ?? null,
          messageId: null,
          toolName: "send_workspace_media_to_chat",
          captionText: null,
          timestampMs: Date.now()
        });
        return;
      }

      const payload = await context.oneBotClient.sendMessage({
        ...target,
        message: segments
      });
      const messageId = recordDeliveredMessage(context, asset.displayName || asset.filename || asset.assetId, payload.data?.message_id);
      context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "onebot",
        mediaKind: "image",
        assetId: asset.assetId,
        filename: asset.filename ?? null,
        messageId,
        toolName: "send_workspace_media_to_chat",
        captionText: null,
        timestampMs: Date.now()
      });
    });
    return {
      content: JSON.stringify({
        ok: true,
        assetRef: asset.displayName,
        assetId: asset.assetId,
        deliveredAs: "image",
        queued: true
      })
    };
  }
};

function recordDeliveredMessage(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_media_to_chat>>[2],
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
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_media_to_chat>>[2],
  requestedAssetRef: string
): Promise<string> {
  const normalized = String(requestedAssetRef ?? "").trim();
  if (!normalized) {
    return "Unknown workspace asset";
  }

  const assets = await context.mediaWorkspace.listAssets().catch(() => []);
  const matchedByDisplayName = assets.find((item) => item.displayName === normalized);
  if (matchedByDisplayName) {
    return [
      `Unknown workspace asset: ${normalized}`,
      `received asset_ref display name; use asset_ref=${matchedByDisplayName.displayName} or asset_id=${matchedByDisplayName.assetId}`
    ].join("; ");
  }
  const matchedByStoredFilename = assets.find((item) => item.storagePath.split("/").at(-1) === normalized);
  if (matchedByStoredFilename) {
    return [
      `Unknown workspace asset: ${normalized}`,
      `received storage filename; use asset_ref=${matchedByStoredFilename.displayName} or asset_id=${matchedByStoredFilename.assetId}`
    ].join("; ");
  }

  const matchedByFilename = assets.find((item) => item.filename === normalized);
  if (matchedByFilename) {
    return [
      `Unknown workspace asset: ${normalized}`,
      `received source filename; use asset_ref=${matchedByFilename.displayName} or asset_id=${matchedByFilename.assetId}`
    ].join("; ");
  }

  return `${"Unknown workspace asset: "}${normalized}. 直接用 asset_ref 短名；若系统同时给了 asset_id，asset_id 是稳定主键。`;
}

async function resolveWorkspaceAsset(
  context: Parameters<NonNullable<typeof workspaceToolHandlers.send_workspace_media_to_chat>>[2],
  assetRef: string
) {
  const normalized = String(assetRef ?? "").trim();
  if (!normalized) {
    return null;
  }
  const direct = await context.mediaWorkspace.getAsset(normalized);
  if (direct) {
    return direct;
  }
  const assets = await context.mediaWorkspace.listAssets().catch(() => []);
  return assets.find((item) => (
    item.displayName === normalized
    || item.storagePath.split("/").at(-1) === normalized
    || item.filename === normalized
  )) ?? null;
}

import type { ChatFileRecord } from "#services/workspace/types.ts";
import type { BuiltinToolContext, ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";

const isNapCatToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.onebot.provider === "napcat";
const isNapCatAvatarToolEnabled: ToolDescriptor["isEnabled"] = (config) => (
  config.onebot.provider === "napcat" && config.chatFiles.enabled
);

export const selfAccountToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "self_account_view",
        description: "查看当前登录 QQ 账号的基础资料：QQ 号、昵称、头像 URL，以及 OneBot 可返回的资料原始字段。不查看或修改在线状态。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    ownerOnly: true,
    isEnabled: isNapCatToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "self_account_avatar_set",
        description: "把当前登录 QQ 账号头像改为已登记图片 asset。只支持 asset_ref/asset_id，不直接接收本地路径。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" }
          },
          anyOf: [
            { required: ["asset_ref"] },
            { required: ["asset_id"] }
          ],
          additionalProperties: false
        }
      }
    },
    ownerOnly: true,
    isEnabled: isNapCatAvatarToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "self_account_signature_set",
        description: "修改当前登录 QQ 账号的个性签名。",
        parameters: {
          type: "object",
          properties: {
            signature: { type: "string" }
          },
          required: ["signature"],
          additionalProperties: false
        }
      }
    },
    ownerOnly: true,
    isEnabled: isNapCatToolEnabled
  }
];

export const selfAccountToolHandlers: Record<string, ToolHandler> = {
  async self_account_view(_toolCall, _args, context) {
    const denied = requireOwner(context.relationship, "Only owner can inspect the bot account");
    if (denied) return denied;
    try {
      const account = await context.oneBotClient.getSelfAccountInfo();
      return JSON.stringify({ ok: true, account });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async self_account_avatar_set(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update the bot account avatar");
    if (denied) return denied;
    const assetRef = getStringArg(args, "asset_ref");
    const assetId = getStringArg(args, "asset_id");
    if (assetRef && assetId) {
      return JSON.stringify({ ok: false, error: "asset_ref and asset_id are mutually exclusive" });
    }
    const selector = assetRef || assetId;
    if (!selector) {
      return JSON.stringify({ ok: false, error: "asset_ref or asset_id is required" });
    }
    try {
      const file = await resolveChatFile(context, selector);
      if (!file) {
        return JSON.stringify({ ok: false, error: await buildUnknownAssetError(context, selector) });
      }
      if (file.kind !== "image" && file.kind !== "animated_image") {
        return JSON.stringify({ ok: false, error: "self_account_avatar_set requires an image asset" });
      }
      const absolutePath = await context.chatFileStore.resolveAbsolutePath(file.fileId);
      const response = await context.oneBotClient.setQQAvatar(absolutePath);
      return JSON.stringify({
        ok: true,
        asset_ref: file.fileRef,
        file_id: file.fileId,
        retcode: response.retcode,
        message: response.message ?? response.wording ?? null
      });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async self_account_signature_set(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update the bot account signature");
    if (denied) return denied;
    const signature = getStringArg(args, "signature");
    if (!signature) {
      return JSON.stringify({ ok: false, error: "signature is required" });
    }
    try {
      const response = await context.oneBotClient.setSelfLongNick(signature);
      return JSON.stringify({
        ok: true,
        updated: { signature },
        retcode: response.retcode,
        message: response.message ?? response.wording ?? null
      });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
};

async function resolveChatFile(context: BuiltinToolContext, fileSelector: string): Promise<ChatFileRecord | null> {
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

async function buildUnknownAssetError(context: BuiltinToolContext, requestedAssetRef: string): Promise<string> {
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

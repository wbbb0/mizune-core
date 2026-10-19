import { z } from "zod";
import type { ToolDescriptor, ToolHandler, BuiltinToolContext } from "../core/shared.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
import { stickerUsagePatchSchema, type StickerRecord } from "#services/stickers/stickerStore.ts";
import { sendImageBytesToChat } from "../core/chatMediaDelivery.ts";

const id = z.string().trim().min(1);
const revision = z.number().int().positive();
const reason = z.string().trim().min(1).max(300);
const schemas = {
  sticker_search: z.object({ query: z.string().trim().max(200).default(""), limit: z.number().int().min(1).max(25).default(5), offset: z.number().int().min(0).default(0) }).strict(),
  sticker_collect: z.object({
    asset_id: id.optional(), qq_url: z.string().url().optional(),
    reason, replace_id: id.optional(), replace_revision: revision.optional()
  }).strict(),
  sticker_update: z.object({ id, revision, reason, patch: stickerUsagePatchSchema.default({}), reread: z.boolean().default(false) }).strict(),
  sticker_remove: z.object({ id, revision, reason }).strict(),
  sticker_send: z.object({ id }).strict(),
  sticker_qq_list: z.object({ count: z.number().int().min(1).max(200).default(48) }).strict()
};
const descriptions: Record<keyof typeof schemas, string> = {
  sticker_search: "按表达意图、情绪或风格检索精选表情，默认只返回5个；空查询可浏览，limit最多25；返回nextOffset时可用offset继续。没有匹配时换简短关键词。不确定时按返回的asset_id调用asset_media_view看图，再决定是否发送。",
  sticker_collect: "收藏值得长期复用的表情：传已有asset_id，或sticker_qq_list中的qq_url。图片精读模型自动生成资料；重复素材不会再次收藏。达到上限必须明确提供replace_id和replace_revision原子替换。只在有新用途或明显更好的替代品时收藏，不必填满或每轮整理；填写简短reason。",
  sticker_update: "维护表情使用情景、情绪、风格、强度、注意事项和使用心得。需要纠正客观画面描述时设reread=true重新调用图片精读模型；不允许直接编造画面描述。使用检索返回的revision，锁定项不能修改。",
  sticker_remove: "淘汰重复或不合适的本地表情收藏，明确给出id、最新revision和reason。不会删除QQ原有收藏或聊天素材。不要仅因低频就删除道歉、安慰等有独特用途的表情。",
  sticker_send: "按稳定id发送已收藏表情到当前聊天。应先检索选择符合语境的候选；不必每轮发图。不确定含义时先看图，避免嘲讽或冒犯。经发送队列发送，queued不代表已送达。",
  sticker_qq_list: "只读获取当前NapCat账号已有收藏的图片URL清单，返回可用于sticker_collect的qq_url；不自动导入、不修改QQ收藏。按需挑选收藏，收藏时再进行图片理解。"
};
export const stickerToolDescriptors: ToolDescriptor[] = (Object.keys(schemas) as Array<keyof typeof schemas>).map((name) => ({
  definition: { type: "function", function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name], { io: "input" }) } },
  isEnabled: (config) => config.stickers.enabled && config.chatFiles.enabled && (name !== "sticker_qq_list" || config.onebot.provider === "napcat"),
  resultObservation: keepRawUnlessLargePolicy({ replaySafe: name === "sticker_search" || name === "sticker_qq_list" })
}));

function view(item: StickerRecord) {
  return { id: item.id, asset_id: item.fileId, revision: item.revision, locked: item.locked,
    ...item.metadata, useCount: item.useCount, lastUsedAtMs: item.lastUsedAtMs };
}
function service(context: BuiltinToolContext) {
  if (!context.config.stickers.enabled || !context.config.chatFiles.enabled || !context.stickerService) throw new Error("表情库未启用。");
  return context.stickerService;
}
const handlers: Record<string, ToolHandler> = {
  async sticker_search(_call, args, context) {
    const input = schemas.sticker_search.parse(args);
    const result = await service(context).search(input.query, input.limit, input.offset);
    return JSON.stringify({ ...result, items: result.items.map(view) });
  },
  async sticker_collect(_call, args, context) {
    const input = schemas.sticker_collect.parse(args);
    if (Boolean(input.asset_id) === (input.qq_url !== undefined)) throw new Error("asset_id与qq_url必须且只能提供一个。");
    if (Boolean(input.replace_id) !== (input.replace_revision !== undefined)) throw new Error("替换必须同时提供replace_id和replace_revision。");
    const library = service(context);
    await library.init();
    const replace = input.replace_id ? { id: input.replace_id, revision: input.replace_revision! } : undefined;
    let fileId = input.asset_id;
    if (input.qq_url !== undefined) {
      if (context.config.onebot.provider !== "napcat") throw new Error("QQ收藏导入需要NapCat。");
      library.store.assertCanAdd(replace);
      const urls = await context.oneBotClient.fetchCustomFaces(200);
      const url = urls.find((candidate) => candidate === input.qq_url);
      if (!url) throw new Error("QQ收藏地址已变化或不在前200项，请重新获取清单。");
      const file = await context.chatFileStore.importRemoteSource({ source: url, kind: "image", origin: "chat_message", sourceContext: { mediaKind: "emoji" } });
      fileId = file.fileId;
    }
    const result = await library.collect({ fileId: fileId!, reason: input.reason, ...(replace ? { replace } : {}), ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}) });
    return JSON.stringify({ ok: true, duplicate: result.duplicate, item: view(result.item) });
  },
  async sticker_update(_call, args, context) {
    const input = schemas.sticker_update.parse(args);
    const item = await service(context).update({ ...input, ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}) });
    return JSON.stringify({ ok: true, item: view(item) });
  },
  async sticker_remove(_call, args, context) {
    const input = schemas.sticker_remove.parse(args);
    const library = service(context); await library.init();
    library.store.remove(input.id, input.revision, input.reason);
    return JSON.stringify({ ok: true, removed: input.id });
  },
  async sticker_send(_call, args, context) {
    const input = schemas.sticker_send.parse(args);
    const library = service(context); await library.init();
    const item = library.store.get(input.id);
    const file = await context.chatFileStore.getFile(item.fileId);
    if (!file) throw new Error("表情素材不存在。");
    const source = file.sourceContext;
    const marketFace = source.emojiId && source.emojiPackageId && source.emojiKey ? [{ type: "mface", data: {
      emoji_id: source.emojiId, emoji_package_id: Number(source.emojiPackageId), key: source.emojiKey, summary: source.emojiSummary ?? "[表情]"
    } }] : undefined;
    return sendImageBytesToChat(context, {
      absolutePath: await context.chatFileStore.resolveAbsolutePath(file.fileId),
      previewText: `[表情：${item.metadata.description}]`, sourceName: file.sourceName,
      fileId: file.fileId, fileRef: file.fileRef, chatFilePath: file.chatFilePath, sourcePath: null,
      toolName: "sticker_send", semanticKind: "emoji", ...(marketFace ? { segments: marketFace } : {}),
      outputExtras: { sticker_id: item.id }, onSent: () => library.store.markUsed(item.id)
    });
  },
  async sticker_qq_list(_call, args, context) {
    service(context);
    if (context.config.onebot.provider !== "napcat") throw new Error("QQ收藏清单需要NapCat。");
    const { count } = schemas.sticker_qq_list.parse(args);
    const urls = await context.oneBotClient.fetchCustomFaces(count);
    return JSON.stringify({ items: urls.map((url) => ({ qq_url: url })), returned: urls.length, requested: count });
  }
};
export const stickerToolHandlers: Record<string, ToolHandler> = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name,
  async (...args: Parameters<ToolHandler>) => {
    try { return await handler(...args); }
    catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
  }
]));

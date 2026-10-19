import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { StickerService } from "../../src/services/stickers/stickerService.ts";
import { AssetLifecycleStore } from "../../src/data/assets/assetLifecycleStore.ts";
import { stickerToolHandlers } from "../../src/llm/tools/runtime/stickerTools.ts";
import { extractContentParts, getSegmentMediaKind } from "../../src/services/onebot/messageSegments.ts";
import type { StickerMetadata } from "../../src/services/stickers/stickerStore.ts";

const metadata: StickerMetadata = {
  description: "猫咪抬头露出得意的笑容", visibleText: "嘿嘿", situations: ["收到夸奖", "轻松回应"],
  emotions: ["开心", "得意"], styles: ["可爱"], intensity: "轻", caution: "不适合严肃道歉", notes: ""
};
async function fixture(capacity = 2) {
  const root = await mkdtemp(join(tmpdir(), "sticker-library-"));
  const logger = createSilentLogger();
  const config = createTestAppConfig({ stickers: { maxCount: capacity }, llm: { enabled: true, models: { main: { chat: { capabilities: { supportsVision: true } } } } } });
  const files = new ChatFileStore(config, logger, { rootDir: root, resolvePath: (path: string) => ({ sourcePath: path, absolutePath: join(root, path) }) } as any, root);
  await files.init();
  const calls: unknown[] = [];
  let answer = JSON.stringify(metadata);
  let block = false;
  let generationGate: (() => Promise<void>) | undefined;
  const service = new StickerService(config, root, logger, files, {
    async prepareFileForModel(fileId: string) {
      if (block) throw new Error("媒体已被内容安全屏蔽");
      return { fileId, inputUrl: "data:image/png;base64,AA==", kind: "image", transport: "data_url", animated: false, durationMs: null, sampledFrameCount: null };
    }
  }, { isConfigured: () => true, async generate(input: { abortSignal?: AbortSignal }) {
    calls.push(input);
    if (generationGate) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(input.abortSignal?.reason);
        input.abortSignal?.addEventListener("abort", abort, { once: true });
        generationGate!().then(resolve, reject).finally(() => input.abortSignal?.removeEventListener("abort", abort));
        if (input.abortSignal?.aborted) abort();
      });
    }
    return { text: answer, usage: {} };
  } } as any);
  await service.init();
  async function image(color: string, sourceContext: Record<string, string | number> = {}) {
    const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer();
    return files.importBuffer({ buffer, sourceName: color + ".png", kind: "image", origin: "chat_message", sourceContext: { mediaKind: "emoji", ...sourceContext } });
  }
  return { root, config, logger, files, service, image, calls, setAnswer: (text: string) => { answer = text; }, setGenerationGate: (gate: () => Promise<void>) => { generationGate = gate; }, block: () => { block = true; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("收藏分析一次、重复素材去重、中文检索不调用模型、锁定与版本保护", async () => {
  const f = await fixture();
  try {
    const file = await f.image("red");
    const first = await f.service.collect({ fileId: file.fileId, reason: "补充可爱回应" });
    const sameBytes = await f.image("red");
    const duplicate = await f.service.collect({ fileId: sameBytes.fileId, reason: "重复收藏" });
    assert.equal(duplicate.item.id, first.item.id);
    assert.equal(duplicate.duplicate, true);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.service.search("夸奖 可爱")).items[0]?.id, first.item.id);
    assert.equal((await f.service.search("火箭发射")).items.length, 0);
    assert.equal(f.calls.length, 1);
    const updated = await f.service.update({ id: first.item.id, revision: 1, patch: { notes: "熟悉朋友间回应" }, reason: "增加使用心得", reread: false });
    assert.equal(updated.revision, 2);
    assert.equal(f.calls.length, 1);
    assert.throws(() => f.service.store.remove(first.item.id, 1, "旧版本删除"), /已变化/);
    f.service.store.setLocked(first.item.id, 2, true);
    await assert.rejects(f.service.update({ id: first.item.id, revision: 3, patch: {}, reason: "改描述", reread: true }), /锁定/);
    assert.throws(() => f.service.store.remove(first.item.id, 3, "删除"), /锁定/);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("并发收藏守住上限；替换失败保留旧项，成功使用新ID", async () => {
  const f = await fixture(1);
  try {
    const [a, b, c] = await Promise.all([f.image("red"), f.image("blue"), f.image("green")]);
    const results = await Promise.allSettled([a, b].map((file) => f.service.collect({ fileId: file.fileId, reason: "收藏" })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const old = f.service.store.list()[0]!;
    assert.throws(() => f.service.store.add({ fileId: "missing", contentHash: "missing", metadata, reason: "失败事务", replace: { id: old.id, revision: old.revision } }), /FOREIGN KEY/);
    assert.equal(f.service.store.list()[0]?.id, old.id);
    f.setAnswer("无效输出");
    await assert.rejects(f.service.collect({ fileId: c.fileId, reason: "替换", replace: { id: old.id, revision: old.revision } }));
    assert.equal(f.service.store.list()[0]?.id, old.id);
    f.setAnswer(JSON.stringify(metadata));
    const next = await f.service.collect({ fileId: c.fileId, reason: "更多用途", replace: { id: old.id, revision: old.revision } });
    assert.notEqual(next.item.id, old.id);
    assert.equal(f.service.store.list().length, 1);
    await assert.rejects(f.service.collect({ fileId: a.fileId, reason: "不能超额" }), /已满/);
  } finally { await f.cleanup(); }
});

test("收藏保护素材免于GC和手动删除；取消收藏后释放保护", async () => {
  const f = await fixture();
  try {
    const file = await f.image("red");
    const item = (await f.service.collect({ fileId: file.fileId, reason: "保留" })).item;
    const lifecycle = new AssetLifecycleStore(f.root, f.logger);
    await lifecycle.init();
    assert.ok((await lifecycle.listReferencedAssetIds("chat_file")).has(file.fileId));
    await assert.rejects(f.files.deleteFile(file.fileId), /FOREIGN KEY/);
    assert.ok(await stat(await f.files.resolveAbsolutePath(file.fileId)));
    f.service.store.remove(item.id, item.revision, "淘汰");
    assert.equal((await lifecycle.listReferencedAssetIds("chat_file")).has(file.fileId), false);
    assert.ok(await f.files.deleteFile(file.fileId));
  } finally { await f.cleanup(); }
});

test("重读才改变客观观察，安全阻断或非法输出不能覆盖资料", async () => {
  const f = await fixture();
  try {
    const file = await f.image("red");
    const item = (await f.service.collect({ fileId: file.fileId, reason: "收藏" })).item;
    await assert.rejects(f.service.update({ id: item.id, revision: 1, patch: { description: "编造" } as any, reason: "改", reread: false }));
    f.setAnswer(JSON.stringify({ ...metadata, description: "猫咪抬起爪子", visibleText: "新文字", situations: ["新推测"], emotions: ["生气"], styles: ["夸张"], intensity: "强", caution: "新猜测", notes: "重读模型猜测" }));
    const updated = await f.service.update({ id: item.id, revision: 1, patch: { notes: "用户反馈心得" }, reason: "修正观察", reread: true });
    assert.deepEqual(updated.metadata, { ...metadata, description: "猫咪抬起爪子", visibleText: "新文字", notes: "用户反馈心得" });
    f.block();
    await assert.rejects(f.service.update({ id: item.id, revision: 2, patch: {}, reason: "再看", reread: true }), /屏蔽/);
    assert.equal(f.service.store.get(item.id).revision, 2);
  } finally { await f.cleanup(); }
});

test("表情发送进入队列，实际发送后才计数，保留emoji transcript", async () => {
  const f = await fixture();
  try {
    const file = await f.image("red");
    const item = (await f.service.collect({ fileId: file.fileId, reason: "收藏" })).item;
    const queued: Array<() => Promise<void>> = [];
    const sent: any[] = [], transcript: any[] = [];
    const context = {
      config: f.config, stickerService: f.service, chatFileStore: f.files,
      relationship: "known", replyDelivery: "onebot", lastMessage: { sessionId: "qqbot:p:10001" },
      messageQueue: { enqueueTextDetached: (job: { send: () => Promise<void> }) => queued.push(job.send) },
      oneBotClient: { sendMessage: async (payload: unknown) => { sent.push(payload); return { data: { message_id: 42 } }; } },
      sessionManager: { recordSentMessage() {}, appendInternalTranscript: (_id: string, data: unknown) => transcript.push(data) }
    } as any;
    const response = await stickerToolHandlers.sticker_send!({} as any, { id: item.id }, context);
    assert.equal(typeof response, "object", JSON.stringify(response));
    assert.equal(f.service.store.get(item.id).useCount, 0);
    assert.equal(queued.length, 1);
    await queued[0]!();
    assert.equal(sent[0].message[0].data.sub_type, 1);
    assert.equal(transcript[0].mediaKind, "emoji");
    assert.equal(transcript[0].toolName, "sticker_send");
    assert.equal(f.service.store.get(item.id).useCount, 1);
    assert.equal(stickerToolHandlers.sticker_set_lock, undefined, "模型工具不提供解锁入口");
  } finally { await f.cleanup(); }
});

test("NapCat image表情和商城表情保留语义及发送元数据，普通照片不误判", () => {
  assert.equal(getSegmentMediaKind({ type: "image", data: { sub_type: "1" } }), "emoji");
  assert.equal(getSegmentMediaKind({ type: "image", data: { sub_type: 0, summary: "[图片]" } }), "image");
  const parts = extractContentParts([{ type: "image", data: { url: "https://example.com/e.gif", emoji_id: "e", emoji_package_id: 123, key: "k", summary: "笑" } }]);
  assert.deepEqual(parts, [{ kind: "emoji", source: "https://example.com/e.gif", marketFace: { emojiId: "e", packageId: 123, key: "k", summary: "笑" } }]);
});

test("重新装配读取已有收藏而不调用模型；降额保留现有库但禁止净新增", async () => {
  const f = await fixture(2);
  try {
    const a = await f.image("red"), b = await f.image("blue"), c = await f.image("green");
    await f.service.collect({ fileId: a.fileId, reason: "收藏A" });
    await f.service.collect({ fileId: b.fileId, reason: "收藏B" });
    f.config.stickers.maxCount = 1;
    const reopened = new StickerService(f.config, f.root, f.logger, f.files, {} as any, {
      isConfigured: () => false, generate: () => { throw new Error("不得调用模型"); }
    } as any);
    const result = await reopened.search("", 25);
    assert.equal(result.total, 2);
    assert.equal(result.capacity, 1);
    const firstPage = await reopened.search("", 1);
    const secondPage = await reopened.search("", 1, firstPage.nextOffset!);
    assert.notEqual(firstPage.items[0]?.id, secondPage.items[0]?.id);
    assert.equal(secondPage.nextOffset, null);
    await assert.rejects(reopened.collect({ fileId: c.fileId, reason: "不能新增" }), /已满/);
    assert.equal((await reopened.collect({ fileId: a.fileId, reason: "重复" })).duplicate, true);
    assert.equal(reopened.store.list().length, 2);
  } finally { await f.cleanup(); }
});

test("商城参数按原协议发送；失败不计数，Web发送保留表情语义", async () => {
  const f = await fixture();
  try {
    const file = await f.image("red", { emojiId: "abc", emojiPackageId: 123, emojiKey: "key", emojiSummary: "笑" });
    const item = (await f.service.collect({ fileId: file.fileId, reason: "收藏" })).item;
    const queue: Array<() => Promise<void>> = [], transcript: any[] = [];
    let fail = true;
    const context = {
      config: f.config, stickerService: f.service, chatFileStore: f.files,
      replyDelivery: "onebot", lastMessage: { sessionId: "qqbot:g:123" },
      messageQueue: { enqueueTextDetached: (job: { send: () => Promise<void> }) => queue.push(job.send) },
      oneBotClient: { sendMessage: async (payload: any) => {
        assert.deepEqual(payload.message, [{ type: "mface", data: { emoji_id: "abc", emoji_package_id: 123, key: "key", summary: "笑" } }]);
        if (fail) throw new Error("发送失败");
        return { data: { message_id: 1 } };
      } },
      sessionManager: { recordSentMessage() {}, appendInternalTranscript: (_id: string, data: unknown) => transcript.push(data) }
    } as any;
    await stickerToolHandlers.sticker_send!({} as any, { id: item.id }, context);
    await assert.rejects(queue.shift()!(), /发送失败/);
    assert.equal(f.service.store.get(item.id).useCount, 0);
    assert.equal(transcript.length, 0);
    fail = false;
    await stickerToolHandlers.sticker_send!({} as any, { id: item.id }, context);
    await queue.shift()!();
    assert.equal(f.service.store.get(item.id).useCount, 1);
    context.replyDelivery = "web";
    context.lastMessage.sessionId = "web:test";
    await stickerToolHandlers.sticker_send!({} as any, { id: item.id }, context);
    await queue.shift()!();
    assert.equal(transcript[1].delivery, "web");
    assert.equal(transcript[1].mediaKind, "emoji");
    assert.equal(f.service.store.get(item.id).useCount, 2);
  } finally { await f.cleanup(); }
});

test("QQ导入核验稳定URL且本地删除不调用QQ删除；禁用后工具拒绝操作", async () => {
  const f = await fixture();
  try {
    f.config.onebot.provider = "napcat";
    const file = await f.image("red");
    let imported = 0;
    const context = { config: f.config, stickerService: f.service, chatFileStore: {
      importRemoteSource: async (input: { source: string }) => { assert.equal(input.source, "https://example.com/emoji.png"); imported++; return file; }
    }, oneBotClient: { fetchCustomFaces: async () => ["https://example.com/emoji.png"] } } as any;
    const missing = await stickerToolHandlers.sticker_collect!({} as any, { qq_url: "https://example.com/old.png", reason: "测试" }, context);
    assert.match(String(missing), /地址已变化/);
    assert.equal(imported, 0);
    const response = await stickerToolHandlers.sticker_collect!({} as any, { qq_url: "https://example.com/emoji.png", reason: "测试" }, context);
    const item = JSON.parse(String(response)).item;
    assert.ok(item.id);
    assert.equal(imported, 1);
    await stickerToolHandlers.sticker_remove!({} as any, { id: item.id, revision: item.revision, reason: "淘汰" }, context);
    assert.equal(f.service.store.list().length, 0);
    f.config.stickers.enabled = false;
    assert.match(String(await stickerToolHandlers.sticker_search!({} as any, {}, context)), /未启用/);
  } finally { await f.cleanup(); }
});

for (const cancelledIndex of [0, 1]) {
  test(`同图共享重读仅取消第${cancelledIndex + 1}个等待者，其他会话继续`, async () => {
    const f = await fixture();
    try {
      const file = await f.image("red");
      const item = (await f.service.collect({ fileId: file.fileId, reason: "收藏" })).item;
      let release!: () => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      f.setGenerationGate(() => { started(); return gate; });
      const controllers = [new AbortController(), new AbortController()];
      const requests = controllers.map((controller) => f.service.update({
        id: item.id, revision: item.revision, patch: {}, reason: "重读",
        reread: true, abortSignal: controller.signal
      }));
      const cancelled = assert.rejects(requests[cancelledIndex]!, /本轮取消/);
      const survivor = requests[1 - cancelledIndex]!;
      await running;
      controllers[cancelledIndex]!.abort(new Error("本轮取消"));
      // 取消必须立即返回，不等共享模型完成；另一个调用仍应完成。
      await cancelled;
      release();
      const updated = await survivor;
      assert.equal(updated.revision, 2);
      assert.equal(f.calls.length, 2, "初次收藏一次、共享重读一次");
    } finally { await f.cleanup(); }
  });
}

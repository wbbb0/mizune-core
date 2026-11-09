import test from "node:test";
import assert from "node:assert/strict";
import { admitCurrentPromptMedia, admitHistoryPromptMedia, withPromptMediaPreparation } from "../../src/app/generation/promptMediaPreparation.ts";
import { buildTag } from "../../src/utils/structuredEnvelope.ts";
import type { GenerationPromptBatchMessage } from "../../src/app/generation/generationPromptBuilder.ts";

const message = (input: Partial<GenerationPromptBatchMessage> = {}): GenerationPromptBatchMessage => ({
  userId: "synthetic", senderName: "合成用户", text: "请查看附件", images: [], emojiSources: [], imageIds: [], emojiIds: [],
  audioIds: [], audioSources: [], forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false,
  isAtMentioned: false, receivedAt: 1, ...input
});

test("current media admission shares one independent limit across images, emoji and audio", () => {
  const input = message({
    imageIds: ["image-1", "image-1"], emojiIds: ["emoji-1"], audioIds: ["audio-1"], audioSources: ["audio-source"],
    attachments: [{ fileId: "image-1", kind: "image", source: "chat_message", sourceName: null, mimeType: "image/png" }]
  });
  const admitted = admitCurrentPromptMedia([input], 2);
  assert.deepEqual([...admitted.fileIds], ["image-1", "emoji-1"]);
  assert.equal(admitted.audioIds.size, 0);
  assert.equal(admitted.omitted, 1);
  assert.deepEqual(input.audioIds, ["audio-1"], "admission must preserve original handles");
  assert.equal(admitCurrentPromptMedia([input], 0).omitted, 3);
});

test("pending media and resolved files use the same current-input quota", () => {
  const admitted = admitCurrentPromptMedia([message({ contentParts: [
    { kind: "pending_media", mediaRef: "media_first", mediaKind: "image", sourceName: "first" },
    { kind: "image", fileId: "file-second", mediaRef: "media_second" }
  ], imageIds: ["file-second"] })], 1);
  assert.deepEqual([...admitted.mediaRefs], ["media_first"]);
  assert.equal(admitted.fileIds.size, 0);
  assert.equal(admitted.omitted, 1);
});

test("current file/video recovery is admitted and folded forward media consumes no quota", () => {
  const files = admitCurrentPromptMedia([message({ contentParts: [
    { kind: "asset_file", fileId: "file", fileKind: "file", mediaRef: "media_file", sourceName: null, mimeType: null, sizeBytes: null },
    { kind: "asset_file", fileId: "video", fileKind: "video", mediaRef: "media_video", sourceName: null, mimeType: null, sizeBytes: null }
  ] })], 1);
  assert.deepEqual([...files.mediaRefs], ["media_file"]);
  assert.equal(files.omitted, 1);
  const forwarded = admitCurrentPromptMedia([message({ contentParts: [
    { kind: "embedded_message", relation: "forward", recordRef: "forward_test", parts: [{ kind: "image", fileId: "hidden" }] },
    { kind: "image", fileId: "visible" }
  ], imageIds: ["hidden", "visible"] })], 1);
  assert.deepEqual([...forwarded.fileIds], ["visible"]);
  assert.equal(forwarded.omitted, 0);
});

test("pending recovery adopts file aliases without expanding either fixed admission set", async () => {
  await withPromptMediaPreparation({ timeoutMs: 1000, maxCurrentMedia: 1, maxHistoryMedia: 1 }, undefined, async scope => {
    const input = [message({ contentParts: [
      { kind: "pending_media", mediaRef: "media_shared", mediaKind: "image", sourceName: null },
      { kind: "pending_media", mediaRef: "media_excess", mediaKind: "image", sourceName: null }
    ] })];
    scope.currentMedia(input);
    const history = [{ content: `${buildTag("pending_media", { media_ref: "media_shared", kind: "image" })}\n${buildTag("asset_file", { file_id: "historical" })}` }];
    scope.historyMedia(history, []);
    scope.recordResolution("media_shared", "resolved-shared");
    scope.recordResolution("media_excess", "must-not-be-admitted");
    assert.deepEqual([...scope.currentMedia([]).fileIds], ["resolved-shared"]);
    assert.deepEqual([...scope.historyMedia([], []).fileIds], ["historical", "resolved-shared"]);
    assert.equal(scope.historyMedia([], []).omitted, 0);
  });
});

test("one preparation deadline covers consecutive phases and aborts the actual work signal", async () => {
  let lastSignal: AbortSignal | undefined;
  const result = await withPromptMediaPreparation({ timeoutMs: 25, maxCurrentMedia: 16, maxHistoryMedia: 16 }, undefined, async scope => {
    await scope.run(async signal => {
      lastSignal = signal;
      await new Promise(resolve => setTimeout(resolve, 5));
    }, undefined, "恢复");
    const value = await scope.run(signal => new Promise<string>((resolve, reject) => {
      assert.equal(signal, lastSignal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), "已就绪的部分", "描述");
    assert.equal(scope.signal.aborted, true);
    assert.match(scope.notes().join("\n"), /总等待期限/);
    scope.finishMediaPreparation();
    assert.match(scope.notes().join("\n"), /总等待期限/, "finishing cannot hide a real timeout");
    let ranAfterDeadline = false;
    await scope.run(async () => { ranAfterDeadline = true; }, undefined, "原生输入");
    assert.equal(ranAfterDeadline, false);
    return value;
  });
  assert.equal(result, "已就绪的部分");
});

test("history admission shares a limit across representations and reuses current owners", () => {
  const shared = buildTag("ref", { kind: "image", image_id: "shared" });
  const audio = buildTag("audio", { audio_id: "audio" });
  const file = buildTag("asset_file", { file_id: "file", media_ref: "media_file" });
  const covered = admitCurrentPromptMedia([message({ imageIds: ["shared"] })], 1);
  const admission = admitHistoryPromptMedia([{ content: `${shared}\n${audio}\n${file}` }], [{ role: "user", content: `${shared}\n${audio}\n${file}` }], 1, covered);
  assert.equal(admission.omitted, 1);
  assert.deepEqual([...admission.fileIds], ["file", "shared"]);
  assert.equal(admission.audioIds.size, 0);
});

test("finish stops only the media deadline and retains caller cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  await withPromptMediaPreparation({ timeoutMs: 10, maxCurrentMedia: 16, maxHistoryMedia: 16 }, controller.signal, async scope => {
    scope.finishMediaPreparation();
    t.mock.timers.tick(1000);
    assert.equal(scope.signal.aborted, false);
    assert.deepEqual(scope.notes(), []);
    const reason = new Error("规则查询期间取消");
    controller.abort(reason);
    assert.equal(scope.signal.reason, reason);
    await assert.rejects(scope.run(async () => "unexpected", "fallback", "ignored"), error => error === reason);
  });
});

test("explicit caller cancellation rejects instead of becoming media degradation", async () => {
  const controller = new AbortController();
  const reason = new Error("本轮被用户取消");
  const pending = withPromptMediaPreparation({ timeoutMs: 1000, maxCurrentMedia: 16, maxHistoryMedia: 16 }, controller.signal, scope => (
    scope.run(signal => new Promise<string>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      controller.abort(reason);
    }), "不能返回此降级结果", "描述")
  ));
  await assert.rejects(pending, error => error === reason);
});

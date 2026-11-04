import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { collectSessionAssetRefs } from "../../src/data/assets/sessionAssetReferences.ts";
import { buildTranscriptItemPatch } from "../../src/conversation/session/transcriptMetadata.ts";
import { resolveLocalReferences } from "../../src/services/messaging/localReferences.ts";
import { projectLlmVisibleHistoryFromTranscript } from "../../src/conversation/session/sessionTranscript.ts";
import { assertKnownMediaReference } from "../../src/services/onebot/referenceAccess.ts";
import type { GenerationPromptBatchMessage } from "../../src/app/generation/generationPromptBuilder.ts";
import { recoverPromptMedia } from "../../src/app/generation/promptMediaRecovery.ts";
import { formatHistoryContent } from "../../src/conversation/session/historyContext.ts";
import type { MediaResolution } from "../../src/services/workspace/mediaSources/types.ts";
import type { MediaImportService } from "../../src/services/workspace/mediaSources/service.ts";
import { projectTimelineContentParts } from "../../webui/src/components/sessions/chatTimeline.ts";

const ref = `media_${"a".repeat(32)}`;
const pending = { kind: "pending_media" as const, mediaRef: ref, mediaKind: "image" as const, sourceName: "图.png" };
const resolution: MediaResolution = { ref, kind: "image", file: { fileId: "file_recovered", fileRef: "recovered.png", kind: "image", origin: "chat_message",
  chatFilePath: "recovered.png", sourceName: "图.png", mimeType: "image/png", sizeBytes: 1, createdAtMs: 1,
  sourceContext: {}, caption: null, captionStatus: "missing", captionUpdatedAtMs: null, captionModelRef: null, captionError: null } };

test("nested pending media resolves in place, updates SSE and GC without changing message identity or exclusions", () => {
  const manager = new SessionManager(createTestAppConfig());
  const id = "qq_official.app:g:group";
  manager.ensureSession({ id, type: "group", source: "qq_official" });
  manager.appendUserHistory(id, { chatType: "group", userId: "member", senderName: "当前发送者", text: "记录", contentParts: [
    { kind: "embedded_message", relation: "forward", senderName: "引用作者", parts: [pending] }
  ] }, 1000, { transcriptGroup: "standalone" });
  const session = manager.getSession(id);
  const original = session.internalTranscript[0]!;
  manager.excludeTranscriptItem(id, original.id!, "manual_single", 1001);
  const excluded = session.internalTranscript[0]!;
  let notifications = 0;
  manager.subscribeSession(id, () => { notifications++; });
  assert.equal(manager.applyResolvedMedia(id, resolution), true);
  const updated = session.internalTranscript[0]!;
  assert.equal(updated.id, original.id);
  assert.equal(updated.timestampMs, 1000);
  assert.equal(updated.groupId, original.groupId);
  assert.equal(updated.runtimeExcluded, true);
  assert.equal(updated.runtimeExcludedAt, 1001);
  assert.ok(updated.kind === "user_message");
  assert.deepEqual(updated.imageIds, ["file_recovered"]);
  assert.ok(Object.isFrozen(updated.contentParts));
  const patch = buildTranscriptItemPatch(excluded, updated);
  assert.ok(patch?.contentParts);
  assert.ok(collectSessionAssetRefs([session], 2000).some(item => item.assetId === "file_recovered"));
  assert.equal(notifications, 1);
  assert.equal(manager.applyResolvedMedia(id, resolution), false, "cache hits must not repeatedly mutate unchanged content");
  manager.clearSession(id);
  assert.equal(manager.applyResolvedMedia(id, resolution), false, "late downloads must not resurrect cleared history");
});

test("official bare reference ids can reuse exact cached native indexes without a remote history API", () => {
  const manager = new SessionManager(createTestAppConfig());
  const id = "qq_official.app:g:group";
  manager.ensureSession({ id, type: "group", source: "qq_official" });
  manager.appendUserHistory(id, { chatType: "group", userId: "owner", senderName: "原发送者", text: "图", contentParts: [pending],
    sourceRef: { platform: "qq_official", connectionId: "qq_official.app", messageId: "native-id", referenceId: "index" } });
  const local = resolveLocalReferences([{ kind: "reply", messageId: "index" }], manager.getSession(id).internalTranscript);
  assert.equal(local[0]?.kind, "embedded_message");
  if (local[0]?.kind === "embedded_message") assert.deepEqual(local[0].parts, [pending]);
  assert.deepEqual(resolveLocalReferences([{ kind: "reply", messageId: "unknown" }], manager.getSession(id).internalTranscript), [{ kind: "reply", messageId: "unknown" }]);
});

test("pure-image asset replacement is delivered through SSE and immediately updates the WebUI image URL", () => {
  const manager = new SessionManager(createTestAppConfig());
  const id = "bot:g:1";
  manager.ensureSession({ id, type: "group" });
  manager.appendUserHistory(id, { chatType: "group", userId: "member", senderName: "发送者", text: "",
    contentParts: [{ kind: "image", fileId: "file_missing", mediaRef: ref }], imageIds: ["file_missing"] });
  const before = manager.getSession(id).internalTranscript[0]!;
  assert.equal(before.kind, "user_media_message");
  manager.applyResolvedMedia(id, resolution);
  const after = manager.getSession(id).internalTranscript[0]!;
  const patch = buildTranscriptItemPatch(before, after)!;
  assert.deepEqual(patch.imageIds, ["file_recovered"]);
  assert.ok(patch.contentParts);
  const merged = { ...before, ...patch };
  assert.ok(merged.kind === "user_media_message");
  const displayed = projectTimelineContentParts(merged.contentParts ?? []);
  assert.equal(displayed[0]?.kind, "image");
  if (displayed[0]?.kind === "image") {
    assert.match(displayed[0].imageUrl, /file_recovered/);
    assert.doesNotMatch(displayed[0].imageUrl, /file_missing/);
  }
});

test("prompt recovery downloads only refs actually present in its history window, replay and active batch", async () => {
  const requested: string[] = [];
  const service = { resolve: async (_scope: unknown, id: string) => { requested.push(id); return resolution; } } as unknown as MediaImportService;
  const input = { sessionId: "qq_official.app:g:group", historyForPrompt: [{ role: "user" as const,
    timestampMs: 1, content: formatHistoryContent({ text: "", contentParts: [{ kind: "embedded_message", relation: "reply", parts: [pending] }] }) }] };
  const recovered = await recoverPromptMedia(service, input);
  assert.deepEqual(requested, [ref]);
  assert.match(recovered.historyForPrompt[0]!.content, /file_recovered/);
  assert.doesNotMatch(recovered.historyForPrompt[0]!.content, /pending_media/);
  requested.length = 0;
  await recoverPromptMedia(service, { sessionId: input.sessionId, historyForPrompt: [] });
  assert.deepEqual(requested, [], "stored but excluded or out-of-window refs must not trigger a download");
});


test("history image budgets retain eligible recovery refs and remove pending refs outside the budget", async () => {
  const config = createTestAppConfig();
  config.llm.routingPresets.default!.historyWindow = { maxRecentMessages: 10, maxImageReferences: 1 };
  const manager = new SessionManager(config);
  const id = "bot:g:1";
  manager.ensureSession({ id, type: "group" });
  manager.appendUserHistory(id, { chatType: "group", userId: "member", senderName: "发送者", text: "旧图", contentParts: [{ kind: "embedded_message", relation: "reply", parts: [pending] }] });
  const newerRef = `media_${"b".repeat(32)}`;
  manager.appendUserHistory(id, { chatType: "group", userId: "member", senderName: "发送者", text: "新图",
    contentParts: [{ kind: "image", fileId: "file_cached", mediaRef: newerRef }], imageIds: ["file_cached"] });
  const session = manager.getSession(id);
  const history = projectLlmVisibleHistoryFromTranscript(session.internalTranscript, config);
  const requested: string[] = [];
  const service = { resolve: async (_scope: unknown, reference: string) => { requested.push(reference); return null; } } as unknown as MediaImportService;
  await recoverPromptMedia(service, { sessionId: id, historyForPrompt: history });
  assert.deepEqual(requested, [newerRef]);
  assert.match(history[0]!.content, /omitted/);
  config.llm.routingPresets.default!.historyWindow.maxImageReferences = 0;
  await recoverPromptMedia(service, { sessionId: id, historyForPrompt: projectLlmVisibleHistoryFromTranscript(session.internalTranscript, config) });
  assert.deepEqual(requested, [newerRef], "zero image budget must not download either pending or cached image refs");
});

test("replaced batch assets are removed from media and attachment lists before prompt preparation", async () => {
  const service = { resolve: async () => resolution } as unknown as MediaImportService;
  const batch: GenerationPromptBatchMessage = { userId: "member", senderName: "发送者", text: "", images: [], audioSources: [], audioIds: [], emojiSources: [],
    forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: true, receivedAt: 1, contentParts: [{ kind: "image", fileId: "file_missing", mediaRef: ref }],
    imageIds: ["file_missing"], emojiIds: [], attachments: [{ fileId: "file_missing", kind: "image", source: "chat_message", sourceName: "old.png", mimeType: "image/png" }]
  };
  const result = await recoverPromptMedia(service, { sessionId: "bot:g:1", historyForPrompt: [], batchMessages: [batch], contentSafetyAlreadyProjected: true });
  assert.deepEqual(result.batchMessages[0]!.imageIds, ["file_recovered"]);
  assert.deepEqual(result.batchMessages[0]!.attachments?.map(file => file.fileId), ["file_recovered"]);
  assert.equal(result.contentSafetyAlreadyProjected, false);
  const sharedOldId = await recoverPromptMedia(service, { sessionId: "bot:g:1", historyForPrompt: [], batchMessages: [{ ...batch,
    contentParts: [...batch.contentParts!, { kind: "image", fileId: "file_missing" }] }] });
  assert.deepEqual(new Set(sharedOldId.batchMessages[0]!.imageIds), new Set(["file_recovered", "file_missing"]));
  assert.deepEqual(new Set(sharedOldId.batchMessages[0]!.attachments?.map(file => file.fileId)), new Set(["file_recovered", "file_missing"]));
});

test("opaque media references require currently visible native content and lose access after exclusion or clear", () => {
  const manager = new SessionManager(createTestAppConfig());
  const id = "bot:g:1";
  manager.ensureSession({ id, type: "group" });
  assert.throws(() => assertKnownMediaReference(manager, id, ref), /不在当前会话/);
  manager.appendUserHistory(id, { chatType: "group", userId: "member", senderName: "发送者", text: ref });
  assert.throws(() => assertKnownMediaReference(manager, id, ref), /不在当前会话/, "text is not a structured native ref");
  manager.appendUserHistory(id, { chatType: "group", userId: "member", senderName: "发送者", text: "图", contentParts: [pending] });
  assert.doesNotThrow(() => assertKnownMediaReference(manager, id, ref));
  manager.excludeTranscriptItem(id, manager.getSession(id).internalTranscript.at(-1)!.id!, "manual_single");
  assert.throws(() => assertKnownMediaReference(manager, id, ref), /不在当前会话/);
  manager.clearSession(id);
  assert.throws(() => assertKnownMediaReference(manager, id, ref), /不在当前会话/);
});

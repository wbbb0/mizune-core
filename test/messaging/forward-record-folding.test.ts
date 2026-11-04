import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { cachedForwardRecordRef, foldForwardRecords, forwardRecordSegments, nativeForwardRecordRef } from "../../src/messages/forwardRecords.ts";
import { foldMessageForModel } from "../../src/messages/modelMessageProjection.ts";
import { formatHistoryContent } from "../../src/conversation/session/historyContext.ts";
import { buildUserBatchContent } from "../../src/llm/prompts/trigger-batch.prompt.ts";
import { recoverPromptMedia } from "../../src/app/generation/promptMediaRecovery.ts";
import { forwardToolHandlers } from "../../src/llm/tools/conversation/forwardTools.ts";
import { transcriptMessageContentPartsSchema } from "../../src/conversation/session/transcriptContract.ts";
import type { MessageContentPart } from "../../src/messages/contentParts.ts";
import type { MediaImportService } from "../../src/services/workspace/mediaSources/service.ts";
import type { GenerationPromptBatchMessage } from "../../src/app/generation/generationPromptBuilder.ts";

type Embedded = Extract<MessageContentPart, { kind: "embedded_message" }>;
const mediaRef = `media_${"c".repeat(32)}`;
const nested: Embedded = { kind: "embedded_message", relation: "forward", parts: [{ kind: "text", text: "内层记录的正文" }] };
const record: Embedded = { kind: "embedded_message", relation: "forward", senderName: "记录作者", parts: [
  { kind: "text", text: "外层记录的正文" }, nested,
  { kind: "image", fileId: "file_hidden", mediaRef }, { kind: "audio", audioId: "aud_hidden" }
] };
function batch(parts: MessageContentPart[] = [record]): GenerationPromptBatchMessage {
  return { userId: "member", senderName: "发送者", text: "查看记录", contentParts: parts, receivedAt: 1,
    images: [], emojiSources: [], audioIds: ["aud_hidden"], audioSources: ["hidden-voice-url"], imageIds: ["file_hidden"], emojiIds: [],
    attachments: [{ fileId: "file_hidden", kind: "image", source: "chat_message", sourceName: "图.png", mimeType: "image/png" }],
    forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: true };
}
function runtime(input: Embedded = record) {
  const sessions = new SessionManager(createTestAppConfig());
  const id = "qq_official.app:g:current";
  sessions.ensureSession({ id, type: "group", source: "qq_official" });
  sessions.appendUserHistory(id, { chatType: "group", userId: "member", senderName: "发送者", text: "记录", contentParts: transcriptMessageContentPartsSchema.parse([input]) });
  let requestedFiles: string[] = [];
  const context = { sessionManager: sessions, lastMessage: { sessionId: id, userId: "member", senderName: "发送者" }, replyDelivery: "qq_official",
    mediaImportService: { resolve: async () => null }, chatFileStore: { getMany: async (ids: string[]) => { requestedFiles.push(...ids); return []; } },
    mediaVisionService: { prepareFilesForModel: async () => { throw new Error("must not prepare hidden images"); } },
    mediaCaptionService: { ensureReady: async () => { throw new Error("must not caption record images"); } },
    audioTranscriber: { ensureReady: async () => { throw new Error("must not transcribe record audio"); } }
  } as unknown as Parameters<NonNullable<typeof forwardToolHandlers.view_forward_record>>[2];
  return { sessions, id, context, requestedFiles };
}
async function view(context: ReturnType<typeof runtime>["context"], ref: string, extra: Record<string, unknown> = {}) {
  const args = { record_ref: ref, ...extra };
  const call = { id: "read", type: "function" as const, function: { name: "view_forward_record", arguments: JSON.stringify(args) } };
  return JSON.parse(String(await forwardToolHandlers.view_forward_record!(call, args, context)));
}

test("history and current batch show folded record handles without text, pictures or audio", () => {
  const history = formatHistoryContent({ text: "请求", contentParts: [record] });
  assert.match(history, /forward_record.*record_ref=/);
  assert.doesNotMatch(history, /外层记录的正文|内层记录的正文|file_hidden|aud_hidden/);
  const visible = foldMessageForModel(batch());
  assert.deepEqual(visible.imageIds, []);
  assert.deepEqual(visible.audioIds, []);
  assert.deepEqual(visible.audioSources, []);
  assert.deepEqual(visible.attachments, []);
  const rendered = JSON.stringify(buildUserBatchContent([{ ...visible, mentionedSelf: true }]));
  assert.match(rendered, /forward_record/);
  assert.doesNotMatch(rendered, /外层记录的正文|内层记录的正文|file_hidden|aud_hidden|hidden-voice-url|image_url/);
  assert.equal(record.parts.length, 4, "model folding must not mutate the canonical WebUI tree");
});

test("folding happens before recovery, preserving a root image that shares a hidden image asset", async () => {
  const rootImage: MessageContentPart = { kind: "image", fileId: "file_hidden" };
  const visible = foldMessageForModel(batch([rootImage, record]));
  assert.deepEqual(visible.imageIds, ["file_hidden"]);
  assert.equal(visible.attachments?.length, 1);
  let recoveries = 0;
  await recoverPromptMedia({ resolve: async () => { recoveries++; return null; } } as unknown as MediaImportService,
    { sessionId: "qq_official.app:g:current", historyForPrompt: [], batchMessages: [batch()] });
  assert.equal(recoveries, 0, "hidden media refs must not initiate prompt-time downloads");
});

test("record fingerprints survive pending image recovery and reject mutation to a different text", () => {
  const pending: Embedded = { ...record, parts: [{ kind: "pending_media", mediaRef, mediaKind: "image", sourceName: "图" }] };
  const resolved: Embedded = { ...record, parts: [{ kind: "image", fileId: "file_new", mediaRef }] };
  assert.equal(cachedForwardRecordRef(pending), cachedForwardRecordRef(resolved));
  const reordered: Embedded = { parts: [{ text: "外层记录的正文", kind: "text" }, nested,
    { mediaRef, fileId: "file_hidden", kind: "image" }, { audioId: "aud_hidden", kind: "audio" }], senderName: "记录作者", relation: "forward", kind: "embedded_message" };
  assert.equal(cachedForwardRecordRef(record), cachedForwardRecordRef(reordered), "JSON property order must not affect a received record handle");
  assert.notEqual(cachedForwardRecordRef(record), cachedForwardRecordRef({ ...record, parts: [{ kind: "text", text: "不同记录" }] }));
});

test("a session tool expands only the selected page; nested records have independently usable handles", async () => {
  const { context } = runtime();
  const result = await view(context, cachedForwardRecordRef(record), { limit: 2 });
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result), /外层记录的正文/);
  assert.doesNotMatch(JSON.stringify(result), /内层记录的正文|file_hidden|data:image|image_url/);
  assert.equal(result.nextOffset, 2);
  const child = result.contentParts[1];
  assert.equal(child.recordRef, cachedForwardRecordRef(nested));
  const expandedChild = await view(context, child.recordRef);
  assert.match(JSON.stringify(expandedChild), /内层记录的正文/);
});

test("many pictures are metadata-only and paged; opening a record never loads image payloads", async () => {
  const many: Embedded = { kind: "embedded_message", relation: "forward", parts: Array.from({ length: 80 }, (_, index) => ({ kind: "image", fileId: `file_pic_${index}` })) };
  const { context, requestedFiles } = runtime(many);
  const first = await view(context, cachedForwardRecordRef(many));
  assert.equal(first.ok, true);
  assert.equal(first.contentParts.length, 10);
  assert.equal(first.nextOffset, 10);
  assert.equal(first.totalSegments, 80);
  assert.equal(requestedFiles.length, 10);
  assert.doesNotMatch(JSON.stringify(first), /image_url|base64|supplementalMessages/);
  const last = await view(context, cachedForwardRecordRef(many), { offset: 70 });
  assert.equal(last.nextOffset, null);
  assert.equal(last.contentParts.length, 10);
  assert.ok((await view(context, cachedForwardRecordRef(many), { limit: 21 })).error);
});

test("record references cannot read across sessions and lose access after exclusion or clear", async () => {
  const { sessions, id, context } = runtime();
  const ref = cachedForwardRecordRef(record);
  sessions.ensureSession({ id: "qq_official.app:g:other", type: "group", source: "qq_official" });
  assert.ok((await view({ ...context, lastMessage: { ...context.lastMessage, sessionId: "qq_official.app:g:other" } }, ref)).error);
  sessions.excludeTranscriptItem(id, sessions.getSession(id).internalTranscript[0]!.id!, "manual_single");
  assert.ok((await view(context, ref)).error);
  sessions.clearSession(id);
  assert.ok((await view(context, ref)).error);
  assert.ok((await view(context, nativeForwardRecordRef("unknown-native"))).error);
});

test("text and card summaries are split into bounded segments and native nested refs survive the shared contract", () => {
  const parts: MessageContentPart[] = [{ kind: "text", text: "字".repeat(3500) }, { kind: "special", segmentType: "qq_card", summary: "卡".repeat(2500) }];
  const segments = forwardRecordSegments(parts);
  assert.equal(segments.length, 7);
  assert.ok(segments.every(part => part.kind === "text" ? part.text.length <= 1000 : part.kind === "special" && part.summary.length <= 1000));
  const native = foldForwardRecords([{ ...nested, messageId: "inner-native-id" }], { nativeReferences: true });
  const parsed = transcriptMessageContentPartsSchema.parse(native);
  assert.equal(parsed[0]?.kind, "forward");
  if (parsed[0]?.kind === "forward") assert.equal(parsed[0].recordRef, nativeForwardRecordRef("inner-native-id"));
});

import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { importIncomingContent } from "../../src/app/messaging/incomingContentImport.ts";
import { collectReferencedImageIds } from "../../src/images/imagePromptContext.ts";
import { processIncomingMessage } from "../../src/app/messaging/messageEventHandler.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { ParsedIncomingMessage } from "../../src/services/messaging/incomingMessage.ts";

function message(): ParsedIncomingMessage {
  return { source: "qq_official", channelId: "qq_official.app", contextOnly: true,
    sourceRef: { platform: "qq_official", connectionId: "qq_official.app", messageId: "context-1" },
    chatType: "group", groupId: "group", userId: "member", senderName: "外层成员", text: "群背景",
    images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [], forwardIds: [],
    replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false,
    contentParts: [{ kind: "text", text: "群背景" }, { kind: "embedded_message", relation: "forward", senderName: "记录作者", parts: [
      { kind: "image", source: "https://example.invalid/image" },
      { kind: "audio", source: "https://example.invalid/audio" },
      { kind: "remote_file", source: "https://example.invalid/file", sourceName: "说明.pdf", mimeType: "application/pdf", fileKind: "file" }
    ] }] };
}

test("recursive import resolves embedded assets in place and keeps authors scoped", async () => {
  const calls: string[] = [];
  const services = {
    audioStore: { registerSources: async (sources: string[]) => sources.map(source => ({ id: "aud_embedded", source })) },
    chatFileStore: { importRemoteSource: async (input: { source: string; kind: string; sourceContext: Record<string, string> }) => {
      calls.push(input.source);
      assert.equal(input.sourceContext.userId, "root-actor");
      return { fileId: input.kind === "image" ? "chat_image" : "chat_file", kind: input.kind, sourceName: "资产", mimeType: "application/test", sizeBytes: 2 };
    } }
  } as unknown as Parameters<typeof importIncomingContent>[0];
  const result = await importIncomingContent(services, message(), "root-actor");
  assert.equal(calls.length, 2);
  const embedded = result.contentParts[1]!;
  assert.equal(embedded.kind, "embedded_message");
  if (embedded.kind !== "embedded_message") return;
  assert.equal(embedded.senderName, "记录作者");
  assert.deepEqual(embedded.parts.map(part => part.kind), ["image", "audio", "asset_file"]);
  assert.equal(JSON.stringify(embedded).includes("https://"), false);
  assert.deepEqual(result.imageIds, ["chat_image"]);
  assert.deepEqual(result.audioIds, ["aud_embedded"]);
});

test("passive group context caches media for later prompts without commands, setup operations or model scheduling", async () => {
  const config = createTestAppConfig();
  const manager = new SessionManager(config);
  const forbidden = () => { throw new Error("passive context must not perform active work"); };
  const reasons: string[] = [];
  const imports: string[] = [];
  const deps = {
    inboundDelivery: "qq_official",
    services: { config, sessionManager: manager, logger: pino({ level: "silent" }),
      audioStore: { registerSources: async (sources: string[]) => sources.map(source => ({ id: "aud_embedded", source })) },
      chatFileStore: { importRemoteSource: async (input: { source: string; kind: string }) => {
        imports.push(input.source);
        return { fileId: input.kind === "image" ? "chat_image" : "chat_file", kind: input.kind,
          sourceName: "资产", mimeType: "application/test", sizeBytes: 2 };
      } },
      mediaCaptionService: { schedule: forbidden, ensureReady: forbidden },
      audioTranscriber: { transcribeMany: forbidden, ensureReady: forbidden },
      userIdentityStore: { ensureUserIdentity: async () => ({ internalUserId: "known" }) },
      userStore: { touchSeenUser: async () => ({ relationship: "known" }) },
      setupStore: { get: async () => ({ state: "ready" }) } },
    handleDirectCommand: forbidden, sendImmediateText: forbidden, flushSession: forbidden,
    persistSession: (_id: string, reason: string) => reasons.push(reason)
  } as unknown as Parameters<typeof processIncomingMessage>[0];
  await processIncomingMessage(deps, message());
  const session = manager.getSession("qq_official.app:g:group");
  assert.equal(session.internalTranscript.length, 1);
  assert.equal(session.pendingMessages.length, 0);
  assert.equal(JSON.stringify(session.internalTranscript).includes("https://"), false);
  assert.ok(reasons.includes("group_context_received"));
  assert.equal(imports.length, 2);
  assert.deepEqual(collectReferencedImageIds(manager.getLlmVisibleHistory(session.id)), ["chat_image"]);
  const item = session.internalTranscript[0]!;
  assert.ok(item.kind === "user_message");
  const embedded = item.contentParts?.[1];
  assert.equal(embedded?.kind, "embedded_message");
  if (embedded?.kind === "embedded_message") {
    assert.deepEqual(embedded.parts.map(part => part.kind), ["image", "audio", "asset_file"]);
  }
  await processIncomingMessage(deps, message());
  assert.equal(imports.length, 2, "replayed context must not reimport media");
  assert.equal(session.internalTranscript.length, 1);
});

test("failed media downloads retain bounded unavailable markers in their original quoted positions", async () => {
  const result = await importIncomingContent({
    audioStore: { registerSources: async () => [] },
    chatFileStore: { importRemoteSource: async () => { throw new Error("synthetic download failure"); } }
  } as unknown as Parameters<typeof importIncomingContent>[0], message(), "root-actor");
  assert.deepEqual(result.imageIds, []);
  assert.deepEqual(result.audioIds, []);
  assert.deepEqual(result.attachments, []);
  const quoted = result.contentParts[1];
  assert.equal(quoted?.kind, "embedded_message");
  if (quoted?.kind === "embedded_message") {
    assert.equal(quoted.senderName, "记录作者");
    assert.ok(quoted.parts.every(part => part.kind === "special" && part.segmentType === "unavailable_media"));
  }
  assert.equal(JSON.stringify(result.contentParts).includes("https://"), false);
});

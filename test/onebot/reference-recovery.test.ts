import test from "node:test";
import assert from "node:assert/strict";
import { OneBotReferenceResolver } from "../../src/services/onebot/referenceResolver.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { forwardToolHandlers } from "../../src/llm/tools/conversation/forwardTools.ts";
import { imageToolHandlers } from "../../src/llm/tools/conversation/imageTools.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createMemoryMediaSources } from "../helpers/media-import-fixtures.ts";
import { MediaImportService } from "../../src/services/workspace/mediaSources/service.ts";
import { nativeForwardRecordRef } from "../../src/messages/forwardRecords.ts";
import { walkMessageContentParts } from "../../src/messages/contentParts.ts";
import type { OneBotClient } from "../../src/services/onebot/onebotClient.ts";
import type { ChatFileRecord } from "../../src/services/workspace/types.ts";

const scope = { connectionId: "bot", sessionId: "bot:g:1" };
const image = { type: "image", data: { url: "https://example.invalid/picture?token=PRIVATE" } };

test("native reply expansion obtains an unseen image and preserves its refresh locator", async () => {
  const resolver = new OneBotReferenceResolver({ getMessage: async () => ({ group_id: 1, user_id: 2,
    message: [image], sender: { nickname: "引用作者" } }) } as unknown as OneBotClient, "bot");
  const parts = await resolver.expand(scope, [{ kind: "reply", messageId: "123" }]);
  const quoted = parts[0]!;
  assert.equal(quoted.kind, "embedded_message");
  if (quoted.kind !== "embedded_message") return;
  const media = quoted.parts[0]!;
  assert.equal(media.kind, "image");
  if (media.kind !== "image") return;
  assert.deepEqual(media.mediaLocator, { kind: "onebot_message", id: "123", imageIndex: 0 });
  assert.equal(await resolver.refresh(scope, media.mediaLocator!), image.data.url);
});

test("private message expansion and URL refresh reject foreign peers and groups", async () => {
  for (const result of [{ user_id: 99, group_id: null }, { user_id: 2, group_id: 99 }]) {
    const resolver = new OneBotReferenceResolver({ getMessage: async () => ({ ...result, message: [image] }) } as unknown as OneBotClient, "bot");
    const privateScope = { connectionId: "bot", sessionId: "bot:p:2" };
    await assert.rejects(resolver.readMessage(privateScope, "123"));
    await assert.rejects(resolver.refresh(privateScope, { kind: "onebot_message", id: "123", imageIndex: 0 }));
    assert.deepEqual(await resolver.expand(privateScope, [{ kind: "reply", messageId: "123" }]), [{ kind: "reply", messageId: "123" }]);
  }
});

test("own private replies require a proven outbound message in that same session", async () => {
  const client = { getMessage: async () => ({ user_id: 999, group_id: null, message: [image] }) } as unknown as OneBotClient;
  const privateScope = { connectionId: "bot", sessionId: "bot:p:2" };
  const resolver = new OneBotReferenceResolver(client, "bot", (actual, id) => actual.sessionId === privateScope.sessionId && id === "known-own");
  await resolver.readMessage(privateScope, "known-own");
  await assert.rejects(resolver.readMessage(privateScope, "other-own"));
  await assert.rejects(resolver.readMessage({ ...privateScope, sessionId: "bot:p:3" }, "known-own"));
  await assert.rejects(resolver.readMessage({ ...privateScope, connectionId: "other" }, "known-own"));
});

test("recursive forwards and cycles share query, media and content budgets", async () => {
  let requests = 0;
  const resolver = new OneBotReferenceResolver({ getForwardMessage: async () => {
    requests++;
    return Array.from({ length: 1000 }, () => ({ type: "node", data: { name: "资料作者", content: [
      image, { type: "text", data: { text: "字".repeat(10000) } }, { type: "forward", data: { id: "cycle" } }
    ] } }));
  } } as unknown as OneBotClient, "bot");
  const parts = await resolver.expand(scope, [{ kind: "forward", forwardId: "cycle" }]);
  const flattened = [...walkMessageContentParts(parts)];
  assert.equal(requests, 1);
  assert.ok(flattened.length <= 400);
  assert.ok(flattened.filter(part => part.kind === "image").length <= 16);
  assert.ok(flattened.reduce((count, part) => count + (part.kind === "text" ? part.text.length : 0), 0) <= 24000);
});

test("forward tools import nested images as real assets accepted by asset_media_view", async () => {
  const config = createTestAppConfig({ onebot: { enabled: true } });
  config.configRuntime.instanceName = "bot";
  const sessions = new SessionManager(config);
  sessions.ensureSession({ id: scope.sessionId, type: "group" });
  sessions.appendUserHistory(scope.sessionId, { chatType: "group", userId: "actor", senderName: "当前发送者", text: "查看记录", forwardIds: ["outer"] });
  let queries = 0;
  const resolver = new OneBotReferenceResolver({ getForwardMessage: async (id: string) => {
    queries++;
    return [{ type: "node", data: { name: "引用作者", content: id === "outer"
      ? [image, { type: "forward", data: { id: "inner" } }] : [{ ...image, data: { url: "https://example.invalid/inner" } }] } }];
  } } as unknown as OneBotClient, "bot");
  const files = new Map<string, ChatFileRecord>();
  const store = {
    deleteFile: async (id: string) => files.delete(id),
    getFile: async (id: string) => files.get(id) ?? null,
    getMany: async (ids: string[]) => ids.map(id => files.get(id)!).filter(Boolean),
    listFiles: async () => [...files.values()], isFileAvailable: async (id: string) => files.has(id),
    importRemoteSource: async (request: { sourceContext?: Record<string, unknown> }) => {
      assert.equal(request.sourceContext?.userId, "actor");
      const file: ChatFileRecord = { fileId: `file_${files.size + 1}`, fileRef: `test${files.size + 1}.png`, kind: "image", origin: "chat_message",
        chatFilePath: "test.png", sourceName: "图.png", mimeType: "image/png", sizeBytes: 1, createdAtMs: 1,
        sourceContext: {}, caption: null, captionStatus: "missing", captionUpdatedAtMs: null, captionModelRef: null, captionError: null };
      files.set(file.fileId, file); return file;
    }
  };
  const media = new MediaImportService({ sources: createMemoryMediaSources(), files: store, refresh: (s, l) => resolver.refresh(s, l) });
  const context = { config, relationship: "known", replyDelivery: "onebot", sessionManager: sessions, oneBotReferenceResolver: resolver,
    mediaImportService: media, chatFileStore: store, audioStore: { registerSources: async () => [], getMany: async () => [] },
    lastMessage: { sessionId: scope.sessionId, userId: "actor", senderName: "当前发送者" },
    mediaVisionService: { prepareFileForModel: async (fileId: string) => ({ fileId, inputUrl: "data:image/png;base64,AAAA", kind: "image", animated: false }) }
  } as unknown as Parameters<NonNullable<typeof forwardToolHandlers.view_forward_record>>[2];
  const call = { id: "forward", type: "function" as const, function: { name: "view_forward_record", arguments: JSON.stringify({ record_ref: nativeForwardRecordRef("outer") }) } };
  const result = JSON.parse(String(await forwardToolHandlers.view_forward_record!(call, { record_ref: nativeForwardRecordRef("outer") }, context)));
  assert.equal(result.ok, true);
  assert.equal(files.size, 2);
  assert.equal(result.assets.length, 1, "nested record images stay behind its own view entry");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(result).includes("forward_image:"), false);
  const viewed = await imageToolHandlers.asset_media_view!({ ...call, function: { name: "asset_media_view", arguments: "{}" } }, { asset_ids: [...files.keys()] }, context);
  assert.equal(typeof viewed, "object");
  assert.equal(queries, 2);
  sessions.appendInternalTranscript(scope.sessionId, { kind: "tool_result", llmVisible: true, toolCallId: call.id,
    toolName: "view_forward_record", timestampMs: Date.now(), content: JSON.stringify(result) });
  const nested = [...walkMessageContentParts(result.contentParts)].find(part => part.kind === "forward");
  assert.ok(nested?.kind === "forward" && nested.recordRef);
  const inner = JSON.parse(String(await forwardToolHandlers.view_forward_record!(call, { record_ref: nested.recordRef }, context)));
  assert.equal(inner.ok, true, JSON.stringify(inner));
  assert.equal(inner.assets.length, 1);
  assert.equal(queries, 3);
  const forbidden = JSON.parse(String(await forwardToolHandlers.view_forward_record!(call, { record_ref: nativeForwardRecordRef("unknown-id") }, context)));
  assert.ok(forbidden.error);
  assert.equal(queries, 3, "unknown identifiers must not query the platform");
});

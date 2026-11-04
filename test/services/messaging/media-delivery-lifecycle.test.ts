import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { SessionManager } from "../../../src/conversation/session/sessionManager.ts";
import { MessageQueue } from "../../../src/conversation/messageQueue.ts";
import { DeliveryCoordinator } from "../../../src/services/messaging/deliveryCoordinator.ts";
import { QqOfficialClient } from "../../../src/services/qqOfficial/client.ts";
import { QqDeliveryError } from "../../../src/services/qqOfficial/types.ts";
import { sendImageBytesToChat } from "../../../src/llm/tools/core/chatMediaDelivery.ts";
import { waitForMediaDelivery } from "../../../src/llm/tools/core/mediaDeliveryStatus.ts";
import { deliveryToolHandlers } from "../../../src/llm/tools/runtime/deliveryTools.ts";
import type { BuiltinToolContext } from "../../../src/llm/tools/core/shared.ts";
import type { QqHttpResponse } from "../../../src/services/qqOfficial/httpClient.ts";

const logger = pino({ level: "silent" });
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN0kAAAAASUVORK5CYII=", "base64");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(run: (context: BuiltinToolContext, input: Parameters<typeof sendImageBytesToChat>[1], manager: SessionManager, queue: MessageQueue) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "delivery-lifecycle-"));
  try {
    const file = join(dir, "image.png"); await writeFile(file, image);
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config), messageQueue = new MessageQueue(logger, config);
    const sessionId = "qq_official.test-app:p:user";
    const session = sessionManager.ensureSession({ id: sessionId, type: "private", source: "qq_official" });
    session.pacingPreferences.outbound = "immediate";
    session.outboundAbortController = new AbortController();
    const context = { config, sessionManager, messageQueue, replyDelivery: "qq_official", lastMessage: { sessionId },
      outboundSignal: session.outboundAbortController.signal } as unknown as BuiltinToolContext;
    await run(context, { absolutePath: file, previewText: "图片", sourceName: "image.png", fileId: "image-asset", fileRef: "image.png",
      chatFilePath: "image.png", sourcePath: null, toolName: "asset_send_to_chat", outputExtras: {} }, sessionManager, messageQueue);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function response(body: unknown): QqHttpResponse { return { ok: true, status: 200, async json() { return body; } }; }

for (const action of ["clear", "delete", "restore"] as const) test(`${action} during official upload aborts submission and never revives delivery or usage`, async () => fixture(async (context, input, manager, queue) => {
  const started = deferred(), release = deferred();
  const calls: string[] = [];
  const client = new QqOfficialClient({ appId: "test-app", appSecret: "test-secret" }, logger, { fetch: async url => {
    calls.push(url);
    if (url.includes("getAppAccessToken")) return response({ access_token: "test-token", expires_in: 7200 });
    if (url.endsWith("/files")) { started.resolve(); await release.promise; return response({ file_info: "uploaded" }); }
    return response({ id: "should-not-send" });
  } });
  context.replyContext = client.acceptEvent("C2C_MESSAGE_CREATE", { id: "incoming", timestamp: new Date().toISOString(), content: "hi", author: { id: "user", user_openid: "user" } })!.permit;
  context.messaging = new DeliveryCoordinator({} as any, client);
  let usage = 0, settled = 0;
  context.beginExternalDelivery = () => ({ ready: Promise.resolve(), settle: () => { settled++; } });
  const send = sendImageBytesToChat(context, { ...input, onSent: () => { usage++; } });
  await started.promise;
  assert.equal(manager.getSession(context.lastMessage.sessionId).internalTranscript[0]?.kind, "outbound_media_message");
  if (action === "clear") manager.clearSession(context.lastMessage.sessionId);
  else if (action === "delete") manager.deleteSession(context.lastMessage.sessionId);
  else manager.restorePersistedSession(manager.getPersistedSession(context.lastMessage.sessionId));
  assert.equal(context.outboundSignal!.aborted, true);
  release.resolve();
  await queue.getDrainPromise(context.lastMessage.sessionId)?.catch(() => {});
  const result = JSON.parse((await send).content);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(url => url.endsWith("/messages")).length, 0);
  const remaining = manager.listSessions().find(session => session.id === context.lastMessage.sessionId)?.internalTranscript ?? [];
  assert.equal(remaining.length, action === "restore" ? 1 : 0);
  if (action === "restore") assert.equal(remaining[0]?.kind === "outbound_media_message" && remaining[0].deliveryStatus, "unknown");
  assert.equal(usage, 0);
  assert.equal(settled, 1);
  assert.equal(result.status, action === "restore" ? "unknown" : "unavailable");
}));

test("bounded wait preserves the live send; scoped status query observes one accepted receipt", async () => fixture(async (context, input, manager) => {
  const started = deferred(), release = deferred(); let usage = 0, persisted = 0;
  context.persistSession = () => { persisted++; };
  context.messaging = { async sendMedia() { started.resolve(); await release.promise; return { platform: "qq_official", connectionId: "qq_official.test-app", messageId: "accepted" }; } } as any;
  const sending = sendImageBytesToChat(context, { ...input, onSent: () => { usage++; } });
  await started.promise;
  const pending = manager.getSession(context.lastMessage.sessionId).internalTranscript[0]!;
  const observed = await waitForMediaDelivery(manager, context.lastMessage.sessionId, pending.id!, 1);
  assert.equal(observed?.deliveryStatus, "sending");
  assert.equal(context.outboundSignal!.aborted, false);
  const caller = { ...context, lastMessage: { sessionId: "web:other" } } as BuiltinToolContext;
  const query = await deliveryToolHandlers.delivery_status!({} as any, { delivery_id: pending.id }, caller);
  assert.equal(JSON.parse(String(query)).status, "unavailable");
  release.resolve();
  const result = JSON.parse((await sending).content);
  assert.equal(result.delivery_id, pending.id);
  assert.equal(result.status, "accepted");
  assert.equal(usage, 1);
  assert.ok(persisted >= 3, "queue and terminal mutations are persisted");
  assert.equal(manager.getSession(context.lastMessage.sessionId).internalTranscript.length, 1);
  assert.equal(manager.patchMediaDelivery(context.lastMessage.sessionId, pending.id!, { deliveryStatus: "accepted" }), false);
}));

test("typed upload failures retain safe stage and code without leaking transport details", async () => fixture(async (context, input) => {
  context.messaging = { async sendMedia() { throw new QqDeliveryError("rejected", "media_file_unavailable", undefined, "upload"); } } as any;
  const result = JSON.parse((await sendImageBytesToChat(context, input)).content);
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.detail, { stage: "upload", code: "media_file_unavailable", message: "媒体发送失败，平台未确认接受。" });
}));

test("synchronous stream-barrier and queue failures settle one safe failed receipt", async () => fixture(async (context, input, manager) => {
  context.beginExternalDelivery = () => { throw new Error("secret=/private/path?token=hidden"); };
  const first = JSON.parse((await sendImageBytesToChat(context, input)).content);
  assert.equal(first.status, "failed");
  assert.equal(first.detail.code, "delivery_barrier_failed");
  assert.doesNotMatch(JSON.stringify(first), /private|hidden/);
  let settled = 0;
  context.beginExternalDelivery = () => ({ ready: Promise.resolve(), settle() { settled++; } });
  context.messageQueue = { enqueueText() { throw new Error("secret=/private/path"); } } as any;
  const second = JSON.parse((await sendImageBytesToChat(context, input)).content);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.status, "failed");
  assert.equal(second.detail.stage, "prepare");
  assert.equal(settled, 1);
  assert.equal(manager.getSession(context.lastMessage.sessionId).internalTranscript.length, 2);
}));

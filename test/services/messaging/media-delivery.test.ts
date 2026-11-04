import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryCoordinator } from "../../../src/services/messaging/deliveryCoordinator.ts";
import type { OneBotClient } from "../../../src/services/onebot/onebotClient.ts";
import type { QqOfficialClient } from "../../../src/services/qqOfficial/client.ts";
import type { QqReplyPermit } from "../../../src/services/qqOfficial/types.ts";
import { sendImageBytesToChat } from "../../../src/llm/tools/core/chatMediaDelivery.ts";
import { createMediaTestSessions, deferredMediaQueue } from "../../helpers/media-delivery-fixtures.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import type { BuiltinToolContext } from "../../../src/llm/tools/core/shared.ts";

async function localMedia(run: (path: string, bytes: Buffer) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "neutral-media-"));
  try { const path = join(root, "image.png"); const bytes = Buffer.from("test-media"); await writeFile(path, bytes); await run(path, bytes); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("OneBot connector encodes image and audio bytes and retains emoji display intent", async () => localMedia(async (filePath, bytes) => {
  const sent: unknown[] = [];
  const client = { sendMessage: async (value: unknown) => { sent.push(value); return { data: { message_id: 7 } }; } } as unknown as OneBotClient;
  const delivery = new DeliveryCoordinator(client);
  for (const kind of ["image", "emoji", "audio"] as const) await delivery.sendMedia({ sessionId: "bot:p:123" }, { filePath, kind });
  assert.deepEqual(sent, [
    { userId: "123", message: [{ type: "image", data: { file: `base64://${bytes.toString("base64")}` } }] },
    { userId: "123", message: [{ type: "image", data: { file: `base64://${bytes.toString("base64")}`, sub_type: 1, summary: "[表情]" } }] },
    { userId: "123", message: [{ type: "record", data: { file: `base64://${bytes.toString("base64")}` } }] }
  ]);
}));

test("native sticker metadata is encoded only by OneBot; official receives the bitmap", async () => localMedia(async (filePath, bytes) => {
  const messages: unknown[] = [], media: unknown[] = [];
  const onebot = { sendMessage: async (value: unknown) => { messages.push(value); return { data: { message_id: 1 } }; } } as unknown as OneBotClient;
  const official = { sendMedia: async (_permit: unknown, value: unknown) => { media.push(value); return { messageId: "opaque", connectionId: "qq_official.app" }; } } as unknown as QqOfficialClient;
  const delivery = new DeliveryCoordinator(onebot, official);
  const nativeEmoji = { id: "emoji", packageId: 12, key: "key", summary: "笑" };
  await delivery.sendMedia({ sessionId: "bot:g:123" }, { filePath, kind: "emoji", nativeEmoji });
  const replyContext: QqReplyPermit = { platform: "qq_official", connectionId: "qq_official.app", chatType: "private", targetId: "user", messageId: "incoming", receivedAtMs: 0, expiresAtMs: 100, maxMessages: 4 };
  await delivery.sendMedia({ sessionId: "qq_official.app:p:user", replyContext }, { filePath, kind: "emoji", nativeEmoji });
  assert.deepEqual(messages, [{ groupId: "123", message: [{ type: "mface", data: { emoji_id: "emoji", emoji_package_id: 12, key: "key", summary: "笑" } }] }]);
  assert.deepEqual(media, [{ fileType: 1, bytes, name: "image.png" }]);
}));

test("chat media helper queues a neutral file request and updates one queued record through acceptance", async () => localMedia(async (absolutePath) => {
  const queued: Array<() => Promise<void>> = [], requests: unknown[] = [], transcript: any[] = [];
  const context = {
    replyDelivery: "onebot", lastMessage: { sessionId: "bot:p:123" },
    messageQueue: deferredMediaQueue(queued),
    sessionManager: createMediaTestSessions(createTestAppConfig(), ["bot:p:123"], transcript),
    messaging: { sendMedia: async (_address: unknown, input: unknown) => { requests.push(input); return { platform: "onebot", messageId: 7 }; } }
  } as unknown as BuiltinToolContext;
  await sendImageBytesToChat(context, { absolutePath, previewText: "图片", sourceName: "image.png", fileId: "asset", fileRef: "image.png", chatFilePath: "image.png", sourcePath: null, toolName: "asset_send_to_chat", outputExtras: {} });
  assert.equal(requests.length, 0); assert.equal(transcript.length, 1);
  assert.equal(transcript[0].deliveryStatus, "queued");
  await queued[0]!();
  assert.deepEqual(requests, [{ filePath: absolutePath, kind: "image", name: "image.png" }]);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].deliveryStatus, "accepted");
}));

import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { QqOfficialClient } from "../../../src/services/qqOfficial/client.ts";
import { QqHttpClient, type QqFetch, type QqHttpResponse } from "../../../src/services/qqOfficial/httpClient.ts";
import { QqReplyPermitRegistry } from "../../../src/services/qqOfficial/replyPermit.ts";
import { QqDeliveryPolicy } from "../../../src/services/qqOfficial/deliveryPolicy.ts";
import { QqTextStream } from "../../../src/services/qqOfficial/textStream.ts";
import { QqDeliveryError } from "../../../src/services/qqOfficial/types.ts";

function response(body: unknown, status = 200): QqHttpResponse { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }
const config = { appId: "test-app", appSecret: "secret-do-not-log", proactiveFallback: false };
const logger = pino({ level: "silent" });
const event = (group = false) => ({
  id: "ROBOT.message", timestamp: new Date().toISOString(), content: "问题", author: { id: "opaque-user", ...(group ? { member_openid: "member" } : { user_openid: "user" }) },
  ...(group ? { group_openid: "group" } : {})
});
function fixture(handler?: (path: string, body: Record<string, unknown>) => Promise<QqHttpResponse> | QqHttpResponse) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetch: QqFetch = async (url, init) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, body, headers: init.headers });
    if (url.includes("getAppAccessToken")) return response({ access_token: "token", expires_in: 7200 });
    return handler ? handler(new URL(url).pathname, body) : response({ id: "platform-message", timestamp: new Date().toISOString() });
  };
  return { fetch, calls };
}

test("official transport rejects disabled full-group events and forwards verified deliveries", () => {
  const f = fixture();
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  assert.equal(client.acceptEvent("GROUP_MESSAGE_CREATE", event(true)), null);
  const incoming = client.acceptEvent("GROUP_AT_MESSAGE_CREATE", event(true));
  assert.ok(incoming);
  assert.equal(incoming.message.isAtMentioned, true);
  assert.equal(incoming.message.rawEvent, undefined);
  assert.equal(incoming.message.sourceRef.connectionId, "qq_official.test-app");
  assert.equal(incoming.message.replyContext, incoming.permit);
  assert.ok(client.acceptEvent("GROUP_AT_MESSAGE_CREATE", event(true)));
});

test("reply permits reject clones, expire, and share one reply budget", () => {
  let now = 1_000;
  const registry = new QqReplyPermitRegistry("qq_official.app", () => now);
  const permit = registry.issue({ chatType: "private", targetId: "user", messageId: "message", timestampMs: now });
  assert.throws(() => registry.allocate({ ...permit }), /invalid_reply_permit/);
  assert.deepEqual([1, 2, 3, 4].map(() => registry.allocate(permit)), [1, 2, 3, 4]);
  assert.throws(() => registry.allocate(permit), /reply_budget_exhausted/);
  now += 3_600_000;
  assert.throws(() => registry.assert(permit), /reply_permit_expired/);
});

test("stream batches deltas, uses one msg_seq, monotonically increments index, and seals", async () => {
  const f = fixture();
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const incoming = client.acceptEvent("C2C_MESSAGE_CREATE", event())!;
  const accepted: string[] = [];
  const stream = client.openTextStream(incoming.permit, { onAccepted: (receipt) => accepted.push(receipt.acceptedText!) });
  stream.append("你"); stream.append("好");
  const receipt = await stream.finish();
  const calls = f.calls.filter((call) => call.url.endsWith("stream_messages"));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.body.content_type === "markdown" && call.body.input_mode === "replace"));
  assert.deepEqual(calls.map((call) => call.body.index), [0, 1]);
  assert.deepEqual(calls.map((call) => call.body.msg_seq), [1, 1]);
  assert.deepEqual(calls.map((call) => call.body.content_raw), ["你好", "你好"]);
  assert.deepEqual(calls.map((call) => call.body.input_state), [1, 10]);
  assert.equal(calls[1]!.body.stream_msg_id, "platform-message");
  assert.equal(receipt?.acceptedText, "你好");
  assert.deepEqual(accepted, ["你好", "你好"]);
  assert.equal(stream.state, "sealed");
});

test("interrupt before submit discards pending local text without creating a platform message", async () => {
  const f = fixture();
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const incoming = client.acceptEvent("C2C_MESSAGE_CREATE", event())!;
  const stream = client.openTextStream(incoming.permit);
  stream.append("不会提交");
  assert.equal(await stream.interrupt(), null);
  assert.equal(f.calls.length, 0);
  assert.equal(stream.state, "sealed");
});

test("interrupt waits for in-flight acceptance, discards later local text, and seals accepted prefix", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const start = new Promise<void>((resolve) => { started = resolve; });
  const f = fixture(async (_path, body) => {
    if (body.index === 0) { started(); await gate; }
    return response({ id: "native-stream" });
  });
  const registry = new QqReplyPermitRegistry("qq_official.test-app");
  const permit = registry.issue({ chatType: "private", targetId: "user", messageId: "trigger", timestampMs: Date.now() });
  const stream = new QqTextStream(new QqHttpClient(config, f.fetch), new QqDeliveryPolicy(new QqHttpClient(config, f.fetch), registry, { proactiveFallback: false }), permit, { flushIntervalMs: 1 });
  stream.append("已提交");
  await start;
  stream.append("丢弃");
  const completion = stream.finish();
  assert.equal(stream.interrupt(), completion);
  release();
  const receipt = await completion;
  assert.equal(receipt?.acceptedText, "已提交");
  assert.deepEqual(f.calls.filter((call) => call.url.endsWith("stream_messages")).map((call) => call.body.content_raw), ["已提交", "已提交"]);
});

test("stream replaces one message with cumulative markdown and seals the complete snapshot", async () => {
  let firstAccepted!: () => void;
  const first = new Promise<void>((resolve) => { firstAccepted = resolve; });
  const f = fixture();
  const registry = new QqReplyPermitRegistry("qq_official.test-app");
  const permit = registry.issue({ chatType: "private", targetId: "user", messageId: "trigger", timestampMs: Date.now() });
  const stream = new QqTextStream(new QqHttpClient(config, f.fetch), new QqDeliveryPolicy(new QqHttpClient(config, f.fetch), registry, { proactiveFallback: false }), permit, {
    onAccepted: () => firstAccepted(), flushIntervalMs: 1
  });
  stream.append("**第一段**\n");
  await first;
  stream.append("第二段");
  await stream.finish();
  const frames = f.calls.filter((call) => call.url.endsWith("stream_messages")).map((call) => call.body);
  assert.deepEqual(frames.map((frame) => frame.content_raw), ["**第一段**\n", "**第一段**\n第二段", "**第一段**\n第二段"]);
  assert.ok(frames.every((frame) => frame.input_mode === "replace" && frame.content_type === "markdown"));
  assert.deepEqual(frames.map((frame) => frame.msg_seq), [1, 1, 1]);
  assert.deepEqual(frames.map((frame) => frame.index), [0, 1, 2]);
  assert.deepEqual(frames.map((frame) => frame.input_state), [1, 1, 10]);
});

test("unknown first stream request is never retried and never seals using an invented id", async () => {
  const f = fixture(() => { throw new Error("response lost with secret-do-not-log"); });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const stream = client.openTextStream(client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit);
  stream.append("正文");
  await assert.rejects(stream.finish(), (error: unknown) => error instanceof QqDeliveryError && error.kind === "unknown" && !error.message.includes(config.appSecret));
  assert.equal(f.calls.filter((call) => call.url.endsWith("stream_messages")).length, 1);
  assert.equal(stream.state, "closure_unknown");
});

test("an unknown continuation retains the accepted prefix and never sends a shorter final snapshot", async () => {
  let firstAccepted!: () => void;
  const first = new Promise<void>((resolve) => { firstAccepted = resolve; });
  const f = fixture((_path, body) => {
    if (body.index === 1) throw new Error("continuation response lost");
    return response({ id: "native-stream" });
  });
  const registry = new QqReplyPermitRegistry("qq_official.test-app");
  const permit = registry.issue({ chatType: "private", targetId: "user", messageId: "trigger", timestampMs: Date.now() });
  const stream = new QqTextStream(new QqHttpClient(config, f.fetch), new QqDeliveryPolicy(new QqHttpClient(config, f.fetch), registry, { proactiveFallback: false }), permit, {
    onAccepted: () => firstAccepted(), flushIntervalMs: 1
  });
  stream.append("已确认");
  await first;
  stream.append("结果未知");
  await assert.rejects(stream.finish(), (error: unknown) => error instanceof QqDeliveryError && error.kind === "unknown");
  const frames = f.calls.filter((call) => call.url.endsWith("stream_messages")).map((call) => call.body);
  assert.deepEqual(frames.map((frame) => frame.content_raw), ["已确认", "已确认结果未知"]);
  assert.ok(frames.every((frame) => frame.input_state === 1));
  assert.equal(stream.receipt?.acceptedText, "已确认");
  assert.equal(stream.state, "closure_unknown");
});

test("media URL upload cannot send directly and then consumes the same text reply budget", async () => {
  const f = fixture((path) => path.endsWith("/files") ? response({ file_info: "opaque-media", ttl: 300 }) : response({ id: "message" }));
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("GROUP_AT_MESSAGE_CREATE", event(true))!.permit;
  await client.sendText(permit, "图片");
  await client.sendMedia(permit, { fileType: 1, url: "https://example.com/image.png" });
  const upload = f.calls.find((call) => call.url.endsWith("/files"))!;
  assert.equal(upload.body.srv_send_msg, false);
  const sends = f.calls.filter((call) => call.url.endsWith("/messages"));
  assert.deepEqual(sends.map((call) => call.body.msg_seq), [1, 2]);
  assert.deepEqual(sends[1]!.body.media, { file_info: "opaque-media" });
});

test("local file uses checksummed split upload without exposing authorization to signed URLs", async () => {
  const f = fixture((path) => {
    if (path.endsWith("upload_prepare")) return response({ upload_id: "upload", block_size: "3", parts: [{ index: 0, block_size: "3", presigned_url: "https://upload.example.com/part" }] });
    if (path.endsWith("/files")) return response({ file_info: "file-info" });
    return response({ id: "file-message" });
  });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await client.sendMedia(permit, { fileType: 4, bytes: Buffer.from("abc"), name: "a.txt" });
  const prepare = f.calls.find((call) => call.url.endsWith("upload_prepare"))!;
  assert.equal(prepare.body.md5, "900150983cd24fb0d6963f7d28e17f72");
  const put = f.calls.find((call) => call.url.includes("upload.example.com"))!;
  assert.equal(put.headers.Authorization, undefined);
  const finish = f.calls.find((call) => call.url.endsWith("upload_part_finish"))!;
  assert.equal(finish.body.part_index, 0);
  assert.equal(finish.body.block_size, "3");
  assert.equal(f.calls.find((call) => call.url.endsWith("/files"))!.body.srv_send_msg, false);
});

test("access token refresh is shared, HTTP rejection is sanitized, and mutations are not replayed", async () => {
  const f = fixture(() => response({ err_code: 11253, message: `credentials ${config.appSecret}` }, 401));
  const http = new QqHttpClient(config, f.fetch);
  assert.deepEqual(await Promise.all([http.accessToken(), http.accessToken()]), ["token", "token"]);
  assert.equal(f.calls.length, 1);
  await assert.rejects(http.request("POST", "/mutation", { content: "private" }), (error: unknown) => error instanceof QqDeliveryError && error.kind === "rejected" && !error.message.includes(config.appSecret));
  assert.equal(f.calls.filter((call) => call.url.endsWith("/mutation")).length, 1);
  await http.accessToken();
  assert.equal(f.calls.filter((call) => call.url.includes("getAppAccessToken")).length, 2);
});

test("stream and tool media allocate separate logical slots from the same original permit", async () => {
  const f = fixture((path) => path.endsWith("/files") ? response({ file_info: "media" }) : response({ id: "message" }));
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  const stream = client.openTextStream(permit);
  stream.append("正文");
  await stream.finish();
  await client.sendMedia(permit, { fileType: 1, url: "https://example.com/image.png" });
  assert.deepEqual(f.calls.filter((call) => call.body.msg_seq).map((call) => call.body.msg_seq), [1, 1, 2]);
});

test("unknown discrete send consumes the reserved slot instead of silently issuing a new sequence", async () => {
  let fail = true;
  const f = fixture(() => {
    if (fail) { fail = false; throw new Error("connection reset"); }
    return response({ id: "message" });
  });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await assert.rejects(client.sendText(permit, "first"), (error: unknown) => error instanceof QqDeliveryError && error.kind === "unknown");
  await client.sendText(permit, "new logical message");
  assert.deepEqual(f.calls.filter((call) => call.url.endsWith("messages")).map((call) => call.body.msg_seq), [1, 2]);
});

test("media cancellation after upload never consumes a reply slot or sends a message", async () => {
  const abort = new AbortController();
  const f = fixture((path) => {
    if (path.endsWith("/files")) { abort.abort(); return response({ file_info: "uploaded" }); }
    return response({ id: "unexpected" });
  });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await assert.rejects(client.sendMedia(permit, { fileType: 1, url: "https://example.com/a.png" }, abort.signal));
  assert.equal(f.calls.filter(call => call.url.endsWith("/messages")).length, 0);
  assert.equal(client.permits.allocate(permit), 2, "released upload reservations do not reuse sequence numbers");
});

test("multipart cancellation after PUT stops part completion and message delivery", async () => {
  const abort = new AbortController();
  const f = fixture((path) => {
    if (path.endsWith("upload_prepare")) return response({ upload_id: "upload", block_size: "3", parts: [{ index: 0, block_size: "3", presigned_url: "https://upload.example.com/part" }] });
    if (path === "/part") { abort.abort(); return response({}); }
    return response({ id: "unexpected" });
  });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await assert.rejects(client.sendMedia(permit, { fileType: 4, bytes: Buffer.from("abc"), name: "a.txt" }, abort.signal));
  assert.equal(f.calls.filter(call => call.url.endsWith("upload_part_finish") || call.url.endsWith("/files") || call.url.endsWith("/messages")).length, 0);
});

const tinyImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN0kAAAAASUVORK5CYII=", "base64");

test("small local images use official SDK raw base64 upload then one passive media message", async () => {
  const f = fixture(path => path.endsWith("/files") ? response({ file_info: "private-file-info", ttl: 300 }) : response({ id: "media-message" }));
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  const receipt = await client.sendMedia(permit, { fileType: 1, bytes: tinyImage, name: "image.png" });
  const upload = f.calls.find(call => call.url.endsWith("/files"))!;
  assert.deepEqual(upload.body, { file_type: 1, file_data: tinyImage.toString("base64"), srv_send_msg: false });
  assert.equal(f.calls.some(call => call.url.includes("upload_prepare")), false);
  const send = f.calls.find(call => call.url.endsWith("/messages"))!;
  assert.deepEqual(send.body, { msg_type: 7, media: { file_info: "private-file-info" }, msg_id: permit.messageId, msg_seq: 1 });
  assert.equal(receipt.status, "accepted");
});

test("exhausted reply budget is rejected before upload or token acquisition", async () => {
  const f = fixture();
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  for (let index = 0; index < 4; index++) client.permits.allocate(permit);
  await assert.rejects(client.sendMedia(permit, { fileType: 1, bytes: tinyImage, name: "image.png" }), error =>
    error instanceof QqDeliveryError && error.stage === "upload" && error.messageStatus === "not_submitted" && error.code === "reply_budget_exhausted");
  assert.equal(f.calls.length, 0);
});

test("concurrent media uploads reserve remaining slots before either upload completes", async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async path => {
    if (path.endsWith("/files")) { started(); await gate; return response({ file_info: "file" }); }
    return response({ id: "media-message" });
  });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  for (let index = 0; index < 3; index++) client.permits.allocate(permit);
  const first = client.sendMedia(permit, { fileType: 1, bytes: tinyImage, name: "image.png" });
  await ready;
  await assert.rejects(client.sendMedia(permit, { fileType: 1, bytes: tinyImage, name: "image.png" }), /reply_budget_exhausted/);
  release();
  await first;
  assert.equal(f.calls.filter(call => call.url.endsWith("/files")).length, 1);
});

test("unknown upload is not an unknown message submission and releases only its upload reservation", async () => {
  const f = fixture(() => { throw new Error("private URL must never escape"); });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await assert.rejects(client.sendMedia(permit, { fileType: 1, bytes: tinyImage, name: "image.png" }), error =>
    error instanceof QqDeliveryError && error.kind === "unknown" && error.stage === "upload" && error.messageStatus === "not_submitted" && !error.message.includes("private URL"));
  assert.equal(f.calls.some(call => call.url.endsWith("/messages")), false);
  assert.deepEqual(Array.from({ length: 4 }, () => client.permits.allocate(permit)), [2, 3, 4, 5]);
});

test("unknown final media POST is retained as submitted and its slot is never released", async () => {
  const f = fixture(path => {
    if (path.endsWith("/files")) return response({ file_info: "file" });
    throw new Error("final response lost");
  });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await assert.rejects(client.sendMedia(permit, { fileType: 1, bytes: tinyImage, name: "image.png" }), error =>
    error instanceof QqDeliveryError && error.stage === "message" && error.messageStatus === "unknown");
  for (let index = 0; index < 3; index++) client.permits.allocate(permit);
  assert.throws(() => client.permits.allocate(permit), /reply_budget_exhausted/);
  assert.equal(f.calls.filter(call => call.url.endsWith("/messages")).length, 1);
});

test("invalid image bytes and oversized images are rejected before any network upload", async () => {
  const f = fixture();
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await assert.rejects(client.sendMedia(permit, { fileType: 1, bytes: Buffer.from("not-an-image"), name: "fake.png" }), /invalid_image_format/);
  await assert.rejects(client.sendMedia(permit, { fileType: 1, bytes: Buffer.alloc(20 * 1024 * 1024 + 1), name: "large.png" }), /media_size_limit/);
  assert.equal(f.calls.length, 0);
});

test("local images over the small-upload threshold keep the fixed split-upload route", async () => {
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
  tinyImage.copy(bytes);
  const f = fixture(path => {
    if (path.endsWith("upload_prepare")) return response({ upload_id: "large", block_size: String(bytes.length), parts: [{ index: 0, block_size: String(bytes.length), presigned_url: "https://upload.example.com/large" }] });
    if (path.endsWith("/files")) return response({ file_info: "large-image" });
    return response({ id: "large-message" });
  });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await client.sendMedia(permit, { fileType: 1, bytes, name: "large.png" });
  assert.equal(f.calls.filter(call => call.url.endsWith("upload_prepare")).length, 1);
  const upload = f.calls.find(call => call.url.endsWith("/files"))!;
  assert.equal(upload.body.upload_id, "large");
  assert.equal(upload.body.file_data, undefined);
  assert.equal(upload.body.srv_send_msg, false);
});

test("reply authorization expiring during upload prevents final media submission", async () => {
  let now = Date.now();
  const f = fixture(path => {
    if (path.endsWith("/files")) { now += 3_600_000; return response({ file_info: "uploaded" }); }
    return response({ id: "unexpected" });
  });
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch, now: () => now });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  await assert.rejects(client.sendMedia(permit, { fileType: 1, bytes: tinyImage, name: "image.png" }), error =>
    error instanceof QqDeliveryError && error.code === "reply_permit_expired" && error.messageStatus === "not_submitted");
  assert.equal(f.calls.some(call => call.url.endsWith("/messages")), false);
});

test("media cancelled before entry reports upload/not_submitted without consuming budget", async () => {
  const f = fixture();
  const client = new QqOfficialClient(config, logger, { fetch: f.fetch });
  const permit = client.acceptEvent("C2C_MESSAGE_CREATE", event())!.permit;
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.sendMedia(permit, { fileType: 1, bytes: tinyImage, name: "image.png" }, abort.signal), error =>
    error instanceof QqDeliveryError && error.stage === "upload" && error.messageStatus === "not_submitted" && error.code === "cancelled");
  assert.equal(f.calls.length, 0);
  for (let index = 0; index < 4; index++) client.permits.allocate(permit);
});

for (const missing of [{ appId: "", appSecret: "secret" }, { appId: "app", appSecret: "" }, { appId: " ", appSecret: " " }]) {
  test(`missing ${missing.appId.trim() ? "secret" : "app ID"} affects authentication without breaking client startup`, async () => {
    let calls = 0;
    const client = new QqOfficialClient(missing, logger, { fetch: async () => { calls++; throw new Error("不应联网"); } });
    try {
      await assert.doesNotReject(client.start());
      await assert.rejects(client.http.accessToken(), (error: unknown) => error instanceof QqDeliveryError && error.code === "missing_credentials" && error.kind === "rejected");
      assert.equal(calls, 0);
    } finally { await client.stop(); }
  });
}

test("authentication rejection is contained by the background connector with safe diagnostics", async () => {
  const lines: string[] = [];
  const diagnosticLogger = pino({ level: "warn" }, { write(line) { lines.push(line); } });
  const client = new QqOfficialClient(config, diagnosticLogger, { fetch: async () => response({ code: 40014, message: "secret-do-not-log", access_token: "private-token" }, 401) });
  try {
    await assert.doesNotReject(client.start());
    await new Promise(resolve => setImmediate(resolve));
    const log = lines.map(line => JSON.parse(line));
    assert.equal(log[0]?.msg, "qq_official_gateway_connect_failed");
    assert.equal(log[0]?.code, "40014");
    assert.equal(log[0]?.httpStatus, 401);
    assert.doesNotMatch(lines.join(""), /secret-do-not-log|private-token/);
  } finally { await client.stop(); }
});

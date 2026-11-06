import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { QqOfficialClient } from "../../../src/services/qqOfficial/client.ts";
import type { QqFetch, QqHttpResponse } from "../../../src/services/qqOfficial/httpClient.ts";
import { QqDeliveryError } from "../../../src/services/qqOfficial/types.ts";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN0kAAAAASUVORK5CYII=", "base64");
const media = { fileType: 1 as const, bytes: image, name: "test.png" };
const response = (body: unknown, status = 200): QqHttpResponse => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });

function fixture(handler?: (path: string, body: Record<string, unknown>) => QqHttpResponse | Promise<QqHttpResponse>, enabled = true) {
  let now = Date.now();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetch: QqFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ path, body });
    if (path.endsWith("getAppAccessToken")) return response({ access_token: "private-token", expires_in: 7200 });
    if (handler) return handler(path, body);
    return path.endsWith("/files") ? response({ file_info: "uploaded" }) : response({ id: "sent" });
  };
  const client = new QqOfficialClient({ appId: "test", appSecret: "private-secret", proactiveFallback: enabled }, pino({ level: "silent" }), { fetch, now: () => now });
  const issue = (chatType: "private" | "group" = "private", targetId = "target", messageId = "trigger") =>
    client.permits.issue({ chatType, targetId, messageId, timestampMs: now });
  return { client, calls, issue, advance: (ms: number) => { now += ms; }, sends: () => calls.filter(call => /\/(?:stream_)?messages$/.test(call.path)) };
}

test("私聊被动回复可持续 60 分钟，群聊在 5 分钟后切换主动，目标与连接保持不变", async () => {
  for (const chatType of ["private", "group"] as const) {
    const f = fixture();
    const permit = f.issue(chatType);
    f.advance(5 * 60_000);
    await f.client.sendText(permit, "回复");
    assert.equal(f.sends()[0]!.body.msg_id, chatType === "private" ? "trigger" : undefined);
    assert.equal(f.sends()[0]!.path, `/v2/${chatType === "private" ? "users" : "groups"}/target/messages`);
    if (chatType === "private") {
      f.advance(55 * 60_000);
      await f.client.sendText(permit, "超时后的结果");
      assert.deepEqual(f.sends()[1]!.body, { msg_type: 0, content: "超时后的结果" });
    }
  }
});

test("私聊文字与图片共用四条被动额度，后续发送自动改为主动", async () => {
  const f = fixture();
  const permit = f.issue();
  await f.client.sendText(permit, "进度");
  for (let i = 0; i < 3; i++) await f.client.sendMedia(permit, media);
  await f.client.sendMedia(permit, media);
  await f.client.sendText(permit, "完成");
  assert.deepEqual(f.sends().map(call => call.body.msg_seq), [1, 2, 3, 4, undefined, undefined]);
  assert.ok(f.sends().slice(4).every(call => !Object.hasOwn(call.body, "msg_id") && !Object.hasOwn(call.body, "event_id")));
  assert.equal(f.calls.filter(call => call.path.endsWith("/files")).length, 4);
});

for (const code of [304103, 40034005, 40034128]) test(`平台明确回复限制 ${code} 时仅切换一次主动发送`, async () => {
  const f = fixture((_path, body) => body.msg_id ? response({ code }, 400) : response({ id: "active" }));
  await f.client.sendText(f.issue(), "正文");
  assert.equal(f.sends().length, 2);
  assert.equal(f.sends()[0]!.body.msg_id, "trigger");
  assert.deepEqual(f.sends()[1]!.body, { msg_type: 0, content: "正文" });
});

for (const code of [40034006, 40034024, 40034100, 40034105, 40054005, 40054013]) test(`其他拒绝 ${code} 不触发重发`, async () => {
  const f = fixture(() => response({ code }, 400));
  await assert.rejects(f.client.sendText(f.issue(), "正文"), error => error instanceof QqDeliveryError && error.code === String(code));
  assert.equal(f.sends().length, 1);
});

test("主动无权限、频控、结果未知及被动服务端异常均不循环重试", async () => {
  for (const outcome of ["permission", "rate", "unknown", "server"] as const) {
    const f = fixture((_path, body) => {
      if (outcome === "server") return response({ code: 40034005 }, 500);
      if (body.msg_id) return response({ code: 40034128 }, 400);
      if (outcome === "unknown") throw new Error("response lost");
      return response({ code: outcome === "rate" ? 40034100 : 40034105 }, 400);
    });
    await assert.rejects(f.client.sendText(f.issue(), "正文"), error => error instanceof QqDeliveryError);
    assert.equal(f.sends().length, outcome === "server" ? 1 : 2);
  }
});

test("被动发送超时且已取消仍保留结果未知，不主动重发", async () => {
  const abort = new AbortController();
  const f = fixture(() => { abort.abort(); throw new Error("response lost"); });
  await assert.rejects(f.client.sendText(f.issue(), "正文", abort.signal), error => error instanceof QqDeliveryError && error.kind === "unknown");
  assert.equal(f.sends().length, 1);
});

test("关闭自动切换或使用伪造授权时不能主动发送", async () => {
  const disabled = fixture(undefined, false);
  const permit = disabled.issue();
  disabled.advance(3_600_000);
  await assert.rejects(disabled.client.sendText(permit, "正文"), /reply_permit_expired/);
  assert.equal(disabled.calls.length, 0);
  const f = fixture();
  const original = f.issue();
  f.advance(3_600_000);
  await assert.rejects(f.client.sendText({ ...original, targetId: "other" }, "正文"), /invalid_reply_permit/);
  await assert.rejects(f.client.sendMedia({ ...original }, media), /invalid_reply_permit/);
  assert.equal(f.calls.length, 0);
});

test("过期授权从去重索引清理后仍只能向最初验证的目标切换", async () => {
  const f = fixture();
  const permit = f.issue();
  f.advance(3_600_000);
  f.issue("private", "another", "new-message");
  await f.client.sendText(permit, "长任务结果");
  assert.equal(f.sends()[0]!.path, "/v2/users/target/messages");
  assert.equal(f.sends()[0]!.body.msg_id, undefined);
});

test("图片上传后被动提交遭拒时复用上传结果，主动提交不重复上传", async () => {
  const f = fixture((path, body) => path.endsWith("/files") ? response({ file_info: "original-upload" })
    : body.msg_id ? response({ code: 40034005 }, 400) : response({ id: "active-media" }));
  await f.client.sendMedia(f.issue(), media);
  assert.equal(f.calls.filter(call => call.path.endsWith("/files")).length, 1);
  assert.deepEqual(f.sends().map(call => call.body.media), [{ file_info: "original-upload" }, { file_info: "original-upload" }]);
  assert.equal(f.sends()[1]!.body.msg_id, undefined);
});

test("上传期间过期可切换，上传失败或取消则不提交消息", async () => {
  for (const outcome of ["expired", "cancelled", "failed"] as const) {
    const abort = new AbortController();
    const f = fixture(path => {
      assert.ok(path.endsWith("/files") || path.endsWith("/messages"));
      if (path.endsWith("/messages")) return response({ id: "active" });
      if (outcome === "failed") throw new Error("upload failed");
      if (outcome === "cancelled") abort.abort();
      f.advance(3_600_000);
      return response({ file_info: "uploaded" });
    });
    const promise = f.client.sendMedia(f.issue(), media, abort.signal);
    if (outcome === "expired") { await promise; assert.equal(f.sends()[0]!.body.msg_id, undefined); }
    else { await assert.rejects(promise); assert.equal(f.sends().length, 0); }
  }
});

test("并发图片只预留一次最后的被动额度，其余使用主动策略", async () => {
  const f = fixture();
  const permit = f.issue();
  for (let i = 0; i < 3; i++) f.client.permits.allocate(permit);
  await Promise.all([f.client.sendMedia(permit, media), f.client.sendMedia(permit, media)]);
  assert.deepEqual(f.sends().map(call => call.body.msg_seq).sort(), [4, undefined]);
});

test("流式额度耗尽时只在结束后主动提交一次完整正文", async () => {
  const f = fixture();
  const permit = f.issue();
  for (let i = 0; i < 4; i++) f.client.permits.allocate(permit);
  const stream = f.client.openTextStream(permit);
  stream.append("第一段");
  stream.append("第二段");
  assert.equal(f.sends().length, 0);
  assert.equal((await stream.finish())?.acceptedText, "第一段第二段");
  assert.deepEqual(f.sends(), [{ path: "/v2/users/target/messages", body: { msg_type: 2, markdown: { content: "第一段第二段" } } }]);
});

test("流式首片明确被拒后可缓冲切换，已接受前缀之后失败不重放", async () => {
  for (const acceptedFirst of [false, true]) {
    let first!: () => void;
    const started = new Promise<void>(resolve => { first = resolve; });
    const f = fixture((path, body) => {
      if (path.endsWith("stream_messages")) {
        first();
        return acceptedFirst && body.index === 0 ? response({ id: "stream" }) : response({ code: 40034005 }, 400);
      }
      return response({ id: "active" });
    });
    const stream = f.client.openTextStream(f.issue());
    stream.append("首段");
    await started;
    stream.append("尾段");
    if (acceptedFirst) {
      await assert.rejects(stream.finish(), /40034005/);
      assert.equal(stream.receipt?.acceptedText, "首段");
      assert.equal(f.sends().filter(call => call.path.endsWith("/messages")).length, 0);
    } else {
      assert.equal((await stream.finish())?.acceptedText, "首段尾段");
      assert.equal(f.sends().filter(call => call.path.endsWith("/messages")).length, 1);
    }
  }
});

test("取消主动流缓冲不发送；首片结果未知不切换", async () => {
  const f = fixture();
  const permit = f.issue();
  f.advance(3_600_000);
  const stream = f.client.openTextStream(permit);
  stream.append("丢弃");
  assert.equal(await stream.interrupt(), null);
  assert.equal(f.calls.length, 0);
  const unknown = fixture(() => { throw new Error("lost"); });
  const lost = unknown.client.openTextStream(unknown.issue());
  lost.append("结果未知");
  await assert.rejects(lost.finish(), error => error instanceof QqDeliveryError && error.kind === "unknown");
  assert.equal(unknown.sends().length, 1);
});

test("主动消息执行端限制单目标每分钟 20 次，窗口恢复后允许新请求", async () => {
  const f = fixture();
  const permit = f.issue();
  f.advance(3_600_000);
  for (let i = 0; i < 20; i++) { await f.client.sendText(permit, "消息"); f.advance(1000); }
  await assert.rejects(f.client.sendText(permit, "超限"), /proactive_rate_limited/);
  assert.equal(f.sends().length, 20);
  f.advance(60_000);
  await f.client.sendText(permit, "恢复");
  assert.equal(f.sends().length, 21);
});

test("流式输出取消后只封口已接受前缀，不发送尚未提交的正文", async () => {
  let accepted!: () => void;
  const ready = new Promise<void>(resolve => { accepted = resolve; });
  const f = fixture();
  const abort = new AbortController();
  const stream = f.client.openTextStream(f.issue(), { signal: abort.signal, onAccepted: () => accepted() });
  stream.append("已接受");
  await ready;
  stream.append("未提交");
  abort.abort();
  assert.equal((await stream.interrupt())?.acceptedText, "已接受");
  assert.deepEqual(f.sends().map(call => call.body.content_raw), ["已接受", "已接受"]);
  assert.deepEqual(f.sends().map(call => call.body.input_state), [1, 10]);
});

test("主动发送也执行 Bot 的每秒与每分钟共享频控", async () => {
  for (const period of ["second", "minute"] as const) {
    const f = fixture();
    const permits = Array.from({ length: 31 }, (_, i) => f.issue("private", `user-${i}`, `message-${i}`));
    f.advance(3_600_000);
    const limit = period === "second" ? 5 : 30;
    for (let i = 0; i < limit; i++) {
      await f.client.sendText(permits[i]!, "主动消息");
      if (period === "minute") f.advance(1000);
    }
    await assert.rejects(f.client.sendText(permits[limit]!, "超限"), /proactive_rate_limited/);
    assert.equal(f.sends().length, limit);
  }
});

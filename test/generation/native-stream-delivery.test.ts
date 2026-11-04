import test from "node:test";
import assert from "node:assert/strict";
import { NativeStreamDelivery } from "../../src/app/generation/nativeStreamDelivery.ts";
import { QqReplyPermitRegistry } from "../../src/services/qqOfficial/replyPermit.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(options: { initialBarrier?: Promise<void>; failSeal?: boolean } = {}) {
  const controller = new AbortController();
  const events: string[] = [];
  const registry = new QqReplyPermitRegistry("qq_official.app");
  const permit = registry.issue({ chatType: "private", targetId: "user", messageId: "incoming", timestampMs: Date.now() });
  const writer = new NativeStreamDelivery({
    initialBarrier: options.initialBarrier ?? Promise.resolve(), signals: () => [controller.signal],
    scheduleStart: async (_text, signal, send) => { await Promise.resolve(); if (!signal.aborted) await send(); },
    captureOpen: () => () => {
      registry.allocate(permit);
      let body = "";
      events.push("open");
      return { receipt: null, append(delta) { body += delta; events.push(`text:${delta}`); },
        async finish() { events.push(`seal:${body}`); if (options.failSeal) throw new Error("seal_unknown"); return null; },
        async interrupt() { events.push("interrupt"); return null; }
      };
    }, accepted() {}, onCloseError() {}
  });
  return { writer, events, controller, registry, permit };
}

test("two media barriers preserve logical text/media order after the tool returns pending", async () => {
  const f = fixture();
  f.writer.append("前");
  const first = f.writer.beginExternalDelivery();
  f.writer.append("中");
  const second = f.writer.beginExternalDelivery();
  f.writer.append("后");
  const finish = f.writer.finish();
  await first.ready;
  f.events.push("media:1");
  await tick(); // The model has already continued while the first media upload is incomplete.
  assert.deepEqual(f.events, ["open", "text:前", "seal:前", "media:1"]);
  first.settle();
  await second.ready;
  f.events.push("media:2");
  assert.deepEqual(f.events, ["open", "text:前", "seal:前", "media:1", "open", "text:中", "seal:中", "media:2"]);
  second.settle();
  await finish;
  assert.deepEqual(f.events.slice(-3), ["open", "text:后", "seal:后"]);
});

test("cancellation exits an unresolved media barrier and never opens the obsolete stream", { timeout: 1000 }, async () => {
  const f = fixture();
  const media = f.writer.beginExternalDelivery();
  f.writer.append("取消的文字");
  await tick();
  f.controller.abort();
  await f.writer.interrupt();
  assert.deepEqual(f.events, []);
  media.settle();
  await tick();
  assert.deepEqual(f.events, []);
});

test("a cancelled media job settles its gate so later authorized output can proceed", async () => {
  const f = fixture();
  const media = f.writer.beginExternalDelivery();
  f.writer.append("后续文字");
  const finish = f.writer.finish();
  await media.ready;
  media.settle();
  media.settle();
  await finish;
  assert.deepEqual(f.events, ["open", "text:后续文字", "seal:后续文字"]);
});

test("an unknown seal prevents media submission and subsequent native text", async () => {
  const f = fixture({ failSeal: true });
  f.writer.append("前文");
  const media = f.writer.beginExternalDelivery();
  f.writer.append("不能越过");
  const finish = f.writer.finish();
  await assert.rejects(media.ready, /seal_unknown/);
  media.settle();
  await assert.rejects(finish, /seal_unknown/);
  assert.deepEqual(f.events, ["open", "text:前文", "seal:前文"]);
});

test("each logical text bubble consumes one reply slot regardless of delta count", async () => {
  const f = fixture();
  for (let bubble = 0; bubble < 4; bubble++) {
    for (let delta = 0; delta < 10; delta++) f.writer.append("字");
    await f.writer.finish();
  }
  f.writer.append("超预算");
  await assert.rejects(f.writer.finish(), /reply_budget_exhausted/);
  assert.equal(f.events.filter(event => event === "open").length, 4);
});

test("a new generation waits for already queued media from the previous response", async () => {
  const previous = deferred();
  const f = fixture({ initialBarrier: previous.promise });
  f.writer.append("新回复");
  const finish = f.writer.finish();
  await tick();
  assert.deepEqual(f.events, []);
  previous.resolve();
  await finish;
  assert.deepEqual(f.events, ["open", "text:新回复", "seal:新回复"]);
});

test("concurrent finish calls both wait for the same seal", async () => {
  const gate = deferred();
  let sealed = false;
  const writer = new NativeStreamDelivery({
    initialBarrier: Promise.resolve(), signals: () => [], scheduleStart: async (_text, _signal, send) => { await Promise.resolve(); await send(); },
    captureOpen: () => () => ({ receipt: null, append() {}, async finish() { await gate.promise; sealed = true; return null; }, async interrupt() { return null; } }),
    accepted() {}, onCloseError() {}
  });
  writer.append("正文");
  const first = writer.finish();
  let secondResolved = false;
  const second = writer.finish().then(() => { secondResolved = true; });
  await tick();
  assert.equal(secondResolved, false);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(sealed, true);
});

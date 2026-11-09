import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { replyWithSseStream } from "../../src/internalApi/routes/sse.ts";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes: string[] = [];
  blockNextWrite = false;
  end() { this.writableEnded = true; }
  writeHead() {}
  write(value: string) {
    this.writes.push(value);
    if (this.blockNextWrite) {
      this.blockNextWrite = false;
      return false;
    }
    return true;
  }
}

function createHarness() {
  const requestRaw = new EventEmitter();
  const raw = new FakeResponse();
  const request = { raw: requestRaw } as any;
  const reply = { raw, hijack() {} } as any;
  return { request, reply, raw, requestRaw };
}

test("SSE safely handles an event emitted synchronously during subscribe", () => {
  const h = createHarness();
  const stream = {
    initialEvents: [] as Array<{ type: string }>,
    subscribe(listener: (event: { type: string }) => void) {
      listener({ type: "session_error" });
      return () => {};
    }
  };
  assert.doesNotThrow(() => replyWithSseStream(h.request, h.reply, stream, {
    isTerminalEvent: (event) => event.type === "session_error"
  }));
  assert.match(h.raw.writes[0] ?? "", /event: session_error/);
  assert.equal(h.raw.writableEnded, true);
});

test("SSE bounds queued events while the client is backpressured", () => {
  const h = createHarness();
  let publish!: (event: { type: string }) => void;
  h.raw.blockNextWrite = true;
  replyWithSseStream(h.request, h.reply, {
    initialEvents: [] as Array<{ type: string }>,
    subscribe(listener) { publish = listener; return () => {}; }
  }, { maxPendingEvents: 2, maxPendingBytes: 1024 });
  publish({ type: "one" });
  publish({ type: "two" });
  publish({ type: "three" });
  publish({ type: "four" });
  assert.equal(h.raw.writableEnded, true);
  assert.equal(h.raw.listenerCount("drain"), 0);
});

test("SSE resumes queued writes after drain and releases subscription on terminal event", () => {
  const h = createHarness();
  let publish!: (event: { type: string }) => void;
  let unsubscribed = false;
  h.raw.blockNextWrite = true;
  replyWithSseStream(h.request, h.reply, {
    initialEvents: [] as Array<{ type: string }>,
    subscribe(listener) { publish = listener; return () => { unsubscribed = true; }; }
  }, { isTerminalEvent: (event) => event.type === "done" });
  publish({ type: "queued" });
  publish({ type: "done" });
  assert.equal(h.raw.writableEnded, false);
  h.raw.emit("drain");
  assert.equal(h.raw.writableEnded, true);
  assert.equal(unsubscribed, true);
  assert.match(h.raw.writes.at(-1) ?? "", /event: done/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import pino from "pino";
import { setImmediate as nextTurn } from "node:timers/promises";
import { QqGateway } from "../../../src/services/qqOfficial/gateway.ts";
import type { QqHttpClient } from "../../../src/services/qqOfficial/httpClient.ts";

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  terminated = false;
  send() {}
  terminate() { this.terminated = true; this.emit("close", 1006); }
  close() { this.emit("close", 1000); }
  payload(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value))); }
}
function fixture(timeout = 10, url = "wss://api.bot.qq.com/websocket") {
  const socket = new Socket();
  const http = { timeoutMs: timeout, async request() { return { url }; }, async accessToken() { return "token"; } } as unknown as QqHttpClient;
  const created: string[] = [];
  const gateway = new QqGateway(http, pino({ level: "silent" }), () => {}, () => { created.push(url); return socket as unknown as WebSocket; }, timeout);
  return { socket, gateway, created };
}

for (const hello of [false, true]) {
  test(`gateway watchdog reconnects when ${hello ? "READY" : "Hello"} never arrives`, async () => {
    const { socket, gateway } = fixture();
    try {
      const closed = new Promise<void>(resolve => socket.once("close", resolve));
      await gateway.start();
      await nextTurn();
      if (hello) socket.payload({ op: 10, d: { heartbeat_interval: 1000 } });
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("watchdog did not fire")), 200))]);
      assert.equal(socket.terminated, true);
    } finally { gateway.stop(); }
  });
}

test("READY cancels handshake watchdog and stop clears remaining lifecycle timers", async () => {
  const { socket, gateway } = fixture();
  await gateway.start();
  await nextTurn();
  socket.payload({ op: 10, d: { heartbeat_interval: 1000 } });
  socket.payload({ op: 0, t: "READY", s: 1, d: { session_id: "session" } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(socket.terminated, false);
  gateway.stop();
  assert.equal(socket.terminated, true);
});

for (const host of ["api.bot.qq.com", "api.sgroup.qq.com"]) {
  test(`accepts official gateway returned at ${host}`, async () => {
    const { gateway, created } = fixture(100, `wss://${host}/websocket`);
    try { await gateway.start(); await nextTurn(); assert.equal(created.length, 1); }
    finally { gateway.stop(); }
  });
}
for (const url of ["wss://api.sgroup.qq.com.attacker.invalid/websocket", "ws://api.sgroup.qq.com/websocket", "wss://api.sgroup.qq.com:8443/websocket"]) {
  test(`rejects untrusted gateway ${url}`, async () => {
    const { gateway, created } = fixture(100, url);
    try { await gateway.start(); assert.equal(created.length, 0); }
    finally { gateway.stop(); }
  });
}

test("initial gateway discovery never blocks startup and stop prevents a late socket", async () => {
  let release!: (value: { url: string }) => void;
  let calls = 0;
  const http = { timeoutMs: 100, request() { calls++; return new Promise(resolve => { release = resolve; }); }, async accessToken() { return "token"; } } as unknown as QqHttpClient;
  let sockets = 0;
  const gateway = new QqGateway(http, pino({ level: "silent" }), () => {}, () => { sockets++; return new Socket() as unknown as WebSocket; });
  let started = false;
  const startup = gateway.start().then(() => { started = true; });
  try {
    await nextTurn();
    assert.equal(started, true, "服务启动不能等待外部网关响应");
    await gateway.start();
    assert.equal(calls, 1, "重复启动不能创建并行连接");
    gateway.stop();
    release({ url: "wss://api.bot.qq.com/websocket" });
    await nextTurn();
    assert.equal(sockets, 0);
  } finally { gateway.stop(); }
  await startup;
});

test("failed discovery retries in the background and stop cancels scheduled retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const http = { timeoutMs: 100, async request() { calls++; throw new Error("private transport details"); } } as unknown as QqHttpClient;
  const gateway = new QqGateway(http, pino({ level: "silent" }), () => {});
  try {
    await gateway.start(); await nextTurn();
    assert.equal(calls, 1);
    t.mock.timers.tick(1000); await nextTurn();
    assert.equal(calls, 2);
    gateway.stop();
    t.mock.timers.tick(60_000); await nextTurn();
    assert.equal(calls, 2);
  } finally { gateway.stop(); }
});

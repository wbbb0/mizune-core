import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { ProtocolMinecraftActorClient } from "../../src/services/minecraft/actorClient.ts";
import { UnixSocketMinecraftActorTransport } from "../../src/services/minecraft/unixSocketTransport.ts";

interface FramedTestServer {
  socketPath: string;
  close(): Promise<void>;
}

function createSnapshot(actorId = "actor-dev") {
  return {
    protocolVersion: 1,
    actorId,
    actorRevision: 0,
    observationRevision: 0,
    self: {
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      connected: true
    },
    activeBehavior: null,
    actionLease: null,
    activeTask: null,
    queuedTaskCount: 0,
    autonomyPolicy: {
      enabled: false,
      idleDelayMs: 10_000,
      collectItems: true,
      explore: true,
      combatHostiles: false,
      exploreRadius: 12,
      combatStopHealth: 8
    }
  };
}

async function startFramedServer(
  onMessage: (socket: Socket, message: Record<string, unknown>, connectionIndex: number) => void
): Promise<FramedTestServer> {
  const directory = await mkdtemp(join(tmpdir(), "mizune-actor-uds-"));
  const socketPath = join(directory, "runtime.sock");
  const sockets = new Set<Socket>();
  let connectionIndex = 0;
  const server = createServer(socket => {
    connectionIndex += 1;
    const ownIndex = connectionIndex;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < length + 4) return;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        onMessage(socket, message, ownIndex);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function reply(socket: Socket, message: Record<string, unknown>, splitAt?: number): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  if (splitAt && splitAt > 0 && splitAt < frame.length) {
    socket.write(frame.subarray(0, splitAt));
    socket.write(frame.subarray(splitAt));
    return;
  }
  socket.write(frame);
}

function replyHello(socket: Socket, message: Record<string, unknown>, connectionIndex: number): void {
  reply(socket, {
    type: "hello_result",
    requestId: message.requestId,
    protocolVersion: 1,
    actorId: "actor-dev",
    sessionId: `session-${connectionIndex}`,
    capabilities: {
      heartbeatIntervalMs: 1_000,
      controllerLeaseTtlMs: 5_000,
      maxFrameBytes: 1_048_576,
      maxEventsPerPage: 256,
      rpcMethods: ["actor.get_snapshot"],
      features: ["request_deadline@1", "durable_idempotency@1", "event_cursor@1", "control_lease@1"]
    }
  }, 3);
}

function createTransport(socketPath: string, requestTimeoutMs = 1_000) {
  return new UnixSocketMinecraftActorTransport({
    socketPath,
    actorId: "actor-dev",
    requestTimeoutMs,
    connectTimeoutMs: 500,
    maxFrameBytes: 1_048_576
  });
}

test("Unix socket transport completes a framed hello and typed actor request", async () => {
  const received: string[] = [];
  const server = await startFramedServer((socket, message, connectionIndex) => {
    received.push(String(message.type));
    if (message.type === "hello") {
      replyHello(socket, message, connectionIndex);
      return;
    }
    if (message.type === "request") {
      assert.equal(message.sessionId, "session-1");
      assert.equal(message.method, "actor.get_snapshot");
      reply(socket, { type: "response", requestId: message.requestId, ok: true, result: createSnapshot() });
    }
  });
  const transport = createTransport(server.socketPath);
  try {
    const client = new ProtocolMinecraftActorClient("actor-dev", transport);
    const snapshot = await client.getSnapshot();
    assert.equal(snapshot.actorId, "actor-dev");
    assert.deepEqual(received.slice(0, 2), ["hello", "request"]);
  } finally {
    await transport.close();
    await server.close();
  }
});

test("response loss reconnects once and reuses the same transport request ID", async () => {
  const requestIds: string[] = [];
  const sessions: string[] = [];
  const server = await startFramedServer((socket, message, connectionIndex) => {
    if (message.type === "hello") {
      replyHello(socket, message, connectionIndex);
      return;
    }
    if (message.type !== "request") return;
    requestIds.push(String(message.requestId));
    sessions.push(String(message.sessionId));
    if (requestIds.length === 1) {
      socket.destroy();
      return;
    }
    reply(socket, { type: "response", requestId: message.requestId, ok: true, result: createSnapshot() });
  });
  const transport = createTransport(server.socketPath);
  try {
    const client = new ProtocolMinecraftActorClient("actor-dev", transport);
    assert.equal((await client.getSnapshot()).self.connected, true);
    assert.equal(requestIds.length, 2);
    assert.equal(requestIds[0], requestIds[1]);
    assert.deepEqual(sessions, ["session-1", "session-2"]);
  } finally {
    await transport.close();
    await server.close();
  }
});

test("request timeout rejects locally and sends a best-effort protocol cancel", async () => {
  let cancelledTarget: string | null = null;
  let requestId: string | null = null;
  const server = await startFramedServer((socket, message, connectionIndex) => {
    if (message.type === "hello") {
      replyHello(socket, message, connectionIndex);
      return;
    }
    if (message.type === "request") requestId = String(message.requestId);
    if (message.type === "cancel") {
      cancelledTarget = String(message.targetRequestId);
      reply(socket, {
        type: "cancel_result",
        requestId: message.requestId,
        targetRequestId: message.targetRequestId,
        cancelled: true
      });
    }
  });
  const transport = createTransport(server.socketPath, 50);
  try {
    const client = new ProtocolMinecraftActorClient("actor-dev", transport);
    await assert.rejects(client.getSnapshot(), /请求超时/u);
    await waitUntil(() => cancelledTarget !== null);
    assert.equal(cancelledTarget, requestId);
  } finally {
    await transport.close();
    await server.close();
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

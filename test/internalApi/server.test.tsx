import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { startInternalApi } from "../../src/internalApi/server.ts";
import { createInternalApiServices } from "../../src/internalApi/types.ts";
import { createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";
import type { ShellRealtimeEvent, ShellSession } from "../../src/services/shell/types.ts";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test("internal api server starts and stops with lifecycle logs", async () => {
  const deps = createInternalApiDeps();
  const capturedLogs: Array<{ message: string; payload: unknown }> = [];
  const port = await getFreePort();
  deps.config.internalApi.port = port;
  deps.logger = {
    info(payload: unknown, message?: string) {
      if (typeof payload === "string") {
        capturedLogs.push({ message: payload, payload: null });
        return;
      }
      capturedLogs.push({ message: message ?? "", payload });
    }
  } as unknown as typeof deps.logger;

  const server = await startInternalApi({
    config: deps.config,
    logger: deps.logger,
    services: createInternalApiServices(deps)
  });
  await server.close();

  assert.deepEqual(capturedLogs, [
    {
      message: "internal_api_started",
      payload: { port, host: "127.0.0.1" }
    },
    {
      message: "internal_api_stopped",
      payload: null
    }
  ]);
});

test("internal api server logs uncaught request errors", async () => {
  const deps = createInternalApiDeps();
  const capturedErrors: Array<{ message: string; payload: Record<string, unknown> }> = [];
  const port = await getFreePort();
  deps.config.internalApi.port = port;
  deps.logger = {
    info() {},
    error(payload: Record<string, unknown>, message?: string) {
      capturedErrors.push({ message: message ?? "", payload });
    }
  } as unknown as typeof deps.logger;
  deps.whitelistStore.getSnapshot = () => {
    throw new Error("config summary exploded");
  };

  const server = await startInternalApi({
    config: deps.config,
    logger: deps.logger,
    services: createInternalApiServices(deps)
  });
  try {
    const response = await server.inject({
      method: "GET",
      url: "/api/config-summary"
    });

    assert.equal(response.statusCode, 500);
    assert.equal(capturedErrors.length, 1);
    assert.equal(capturedErrors[0]?.message, "internal_api_request_failed");
    assert.equal(capturedErrors[0]?.payload.method, "GET");
    assert.equal(capturedErrors[0]?.payload.url, "/api/config-summary");
    assert.equal(capturedErrors[0]?.payload.error, "config summary exploded");
  } finally {
    await server.close();
  }
});

test("internal api binds unauthenticated built-in webui on all interfaces", async () => {
  const deps = createInternalApiDeps();
  const capturedLogs: Array<{ message: string; payload: unknown }> = [];
  const port = await getFreePort();
  deps.config.internalApi.webui.enabled = true;
  deps.config.internalApi.webui.auth.enabled = false;
  deps.config.internalApi.webui.port = port;
  deps.logger = {
    info(payload: unknown, message?: string) {
      if (typeof payload === "string") {
        capturedLogs.push({ message: payload, payload: null });
        return;
      }
      if (message === "internal_api_started" || message === "internal_api_stopped") {
        capturedLogs.push({ message: message ?? "", payload });
      }
    },
    warn() {}
  } as unknown as typeof deps.logger;

  const server = await startInternalApi({
    config: deps.config,
    logger: deps.logger,
    services: createInternalApiServices(deps)
  });
  await server.close();

  assert.deepEqual(capturedLogs, [
    {
      message: "internal_api_started",
      payload: { port, host: "0.0.0.0" }
    },
    {
      message: "internal_api_stopped",
      payload: null
    }
  ]);
});

test("internal api exposes authenticated built-in webui on lan", async () => {
  const deps = createInternalApiDeps();
  const capturedLogs: Array<{ message: string; payload: unknown }> = [];
  const port = await getFreePort();
  deps.config.internalApi.webui.enabled = true;
  deps.config.internalApi.webui.auth.enabled = true;
  deps.config.internalApi.webui.port = port;
  deps.logger = {
    info(payload: unknown, message?: string) {
      if (typeof payload === "string") {
        capturedLogs.push({ message: payload, payload: null });
        return;
      }
      if (message === "internal_api_started" || message === "internal_api_stopped") {
        capturedLogs.push({ message: message ?? "", payload });
      }
    },
    warn() {}
  } as unknown as typeof deps.logger;

  const server = await startInternalApi({
    config: deps.config,
    logger: deps.logger,
    services: createInternalApiServices(deps)
  });
  await server.close();

  assert.deepEqual(capturedLogs, [
    {
      message: "internal_api_started",
      payload: { port, host: "0.0.0.0" }
    },
    {
      message: "internal_api_stopped",
      payload: null
    }
  ]);
});

test("internal api shell websocket attaches and queues early input", async () => {
  const deps = createInternalApiDeps();
  const port = await getFreePort();
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let subscribed = false;
  let disposed = false;
  let resolveSubscription: (value: {
    session: ShellSession;
    replay: string;
    dispose: () => void;
  }) => void = () => {
    throw new Error("subscribe was not started");
  };

  deps.config.internalApi.port = port;
  deps.shellRuntime = {
    async subscribe(_sessionId: string, send: (event: ShellRealtimeEvent) => void) {
      subscribed = true;
      send({ kind: "output", data: "before hello\n" });
      return await new Promise<{
        session: ShellSession;
        replay: string;
        dispose: () => void;
      }>((resolve) => {
        resolveSubscription = resolve;
      });
    },
    async writeRaw(_sessionId: string, input: string) {
      writes.push(input);
      return createServerTestShellSession();
    },
    async resize(_sessionId: string, cols: number, rows: number) {
      resizes.push([cols, rows]);
      return createServerTestShellSession();
    },
    async signal() {
      return createServerTestShellSession();
    },
    closeSession() {}
  } as unknown as typeof deps.shellRuntime;

  const server = await startInternalApi({
    config: deps.config,
    logger: deps.logger,
    services: createInternalApiServices(deps)
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/shell/sessions/shell-1/attach`);
  const messages: unknown[] = [];
  try {
    ws.on("message", (message) => {
      messages.push(JSON.parse(message.toString("utf8")) as unknown);
    });
    await waitForWebSocketOpen(ws);
    assert.equal(subscribed, true);

    ws.send(JSON.stringify({ kind: "input", data: "echo hi\n" }));
    ws.send(JSON.stringify({ kind: "resize", cols: 120, rows: 40 }));
    assert.deepEqual(writes, []);
    assert.deepEqual(resizes, []);

    resolveSubscription({
      session: createServerTestShellSession(),
      replay: "tail\n",
      dispose: () => {
        disposed = true;
      }
    });
    await waitFor(() => writes.length === 1 && resizes.length === 1 && messages.length >= 1);

    assert.deepEqual(writes, ["echo hi\n"]);
    assert.deepEqual(resizes, [[120, 40]]);
    assert.equal((messages[0] as { kind?: string }).kind, "hello");
  } finally {
    ws.close();
    await server.close();
  }

  assert.equal(disposed, true);
});

test("internal api shell websocket caps input queued before attach is ready", async () => {
  const deps = createInternalApiDeps();
  const port = await getFreePort();
  let subscribed = false;
  deps.config.internalApi.port = port;
  deps.shellRuntime = {
    async subscribe() {
      subscribed = true;
      return await new Promise(() => {});
    }
  } as unknown as typeof deps.shellRuntime;

  const server = await startInternalApi({
    config: deps.config,
    logger: deps.logger,
    services: createInternalApiServices(deps)
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/shell/sessions/shell-1/attach`);
  try {
    await waitForWebSocketOpen(ws);
    assert.equal(subscribed, true);

    for (let index = 0; index < 1100 && ws.readyState === WebSocket.OPEN; index += 1) {
      ws.send(JSON.stringify({ kind: "input", data: "x" }));
    }

    const close = await waitForWebSocketClose(ws);
    assert.equal(close.opened, true);
  } finally {
    ws.close();
    await server.close();
  }
});

test("internal api shell websocket ignores malformed attach path before auth", async () => {
  const deps = createInternalApiDeps();
  const port = await getFreePort();
  deps.config.internalApi.webui.enabled = true;
  deps.config.internalApi.webui.auth.enabled = true;
  deps.config.internalApi.webui.port = port;
  deps.shellRuntime = {
    async subscribe() {
      throw new Error("should not subscribe malformed attach path");
    }
  } as unknown as typeof deps.shellRuntime;

  const server = await startInternalApi({
    config: deps.config,
    logger: deps.logger,
    services: createInternalApiServices(deps)
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/shell/sessions/%E0%A4%A/attach`);
  try {
    const close = await waitForWebSocketClose(ws);
    assert.equal(close.opened, false);
  } finally {
    ws.close();
    await server.close();
  }
});

function createServerTestShellSession(): ShellSession {
  return {
    id: "shell-1",
    command: "zsh",
    cwd: "/tmp",
    shell: "/bin/zsh",
    login: true,
    tty: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    status: "running",
    pid: 123,
    exitCode: null,
    signal: null,
    outputTail: "",
    error: null,
    ownerSessionId: null,
    ownerUserId: null,
    ownerSenderName: null,
    notifyPolicy: "none",
    lastOutputAtMs: null,
    lastInputAtMs: null,
    lastInputPromptKind: null,
    lastInputPromptAtMs: null
  };
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function waitForWebSocketClose(ws: WebSocket): Promise<{ opened: boolean }> {
  let opened = ws.readyState === WebSocket.OPEN;
  return await new Promise((resolve) => {
    ws.once("open", () => {
      opened = true;
    });
    ws.once("close", () => {
      resolve({ opened });
    });
    ws.once("error", () => {
      resolve({ opened });
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2000) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

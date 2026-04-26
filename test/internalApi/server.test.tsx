import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { startInternalApi } from "../../src/internalApi/server.ts";
import { createInternalApiServices } from "../../src/internalApi/types.ts";
import { createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

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

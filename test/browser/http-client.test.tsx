import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { WebHttpClient } from "../../src/services/web/browser/httpClient.ts";

test("web http client preserves custom headers and injects default user agent", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      userAgent: req.headers["user-agent"] ?? null,
      xTest: req.headers["x-test"] ?? null
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new WebHttpClient();
    const response = await client.fetch(`http://127.0.0.1:${address.port}/`, {
      headers: {
        "X-Test": "hello"
      }
    });
    const body = await response.json() as { userAgent: string | null; xTest: string | null };
    assert.equal(body.userAgent, "llm-bot/0.1");
    assert.equal(body.xTest, "hello");
  } finally {
    server.close();
    await once(server, "close");
  }
});

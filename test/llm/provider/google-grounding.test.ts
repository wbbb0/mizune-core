import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { GoogleGroundingProvider } from "#services/web/search/googleGroundingProvider.ts";
import type { WebHttpClient } from "#services/web/browser/httpClient.ts";

test("独立 Grounding 复用 search 客户端，以请求头鉴权并禁用服务端存储", async () => {
  let calls = 0;
  const httpClient = { async fetch(url: string, init: RequestInit) {
    calls++; assert.equal(new URL(url).search, ""); assert.equal(new Headers(init.headers).get("x-goog-api-key"), "synthetic-key");
    assert.equal(JSON.parse(String(init.body)).store, false); assert.ok(init.signal);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "结果" }] } }] }));
  } } as unknown as WebHttpClient;
  const provider = new GoogleGroundingProvider({ apiKey: "synthetic-key", model: "test-model", timeoutMs: 1000, maxSources: 3, resolveRedirectUrls: false }, httpClient, pino({ level: "silent" }));
  const result = await provider.search({ query: "公开测试" });
  assert.equal(result.ok, true); assert.equal(calls, 1);
});

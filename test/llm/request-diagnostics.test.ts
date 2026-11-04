import test from "node:test";
import assert from "node:assert/strict";
import { requestWithDiagnostics, safeCauseCodes, getRequestDiagnostic } from "../../src/llm/provider/requestDiagnostics.ts";
import { filterLogContent } from "../../src/logging/logContentFilter.ts";

test("explicit temporary nested transport failure retries once before response", async () => {
  let calls = 0;
  const value = await requestWithDiagnostics(async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error("private URL?key=secret"), { code: "ECONNREFUSED" })]) });
    return "ok";
  }, undefined);
  assert.equal(value, "ok"); assert.equal(calls, 2);
});
test("unknown failure and aborted request cannot retry", async () => {
  for (const aborted of [false, true]) {
    let calls = 0;
    const controller = new AbortController();
    if (aborted) controller.abort();
    const error = Object.assign(new Error("private body"), aborted ? { code: "ECONNRESET" } : {});
    await assert.rejects(requestWithDiagnostics(async () => { calls++; throw error; }, controller.signal));
    assert.equal(calls, aborted ? 0 : 1); if (!aborted) assert.equal(getRequestDiagnostic(error)?.willRetry, false);
  }
});
test("cause cycles bounded; privacy projection rejects arbitrary strings", () => {
  const error = Object.assign(new Error("secret"), { code: "ECONNRESET", cause: null as unknown }); error.cause = error;
  assert.deepEqual(safeCauseCodes(error), ["ECONNRESET"]);
  const result = filterLogContent({ requestDiagnostic: { requestId: "00000000-0000-0000-0000-000000000000", stage: "connect", causeCodes: ["ECONNRESET", "secret"], elapsedMs: 12, message: "secret", url: "https://secret" } });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual((result.requestDiagnostic as {causeCodes: string[]}).causeCodes, ["ECONNRESET"]);
});

test("mixed permanent and temporary causes cannot retry", async () => {
  let calls = 0;
  const error = new AggregateError([Object.assign(new Error(), { code: "ECONNRESET" }), Object.assign(new Error(), { code: "CERT_HAS_EXPIRED" })]);
  await assert.rejects(requestWithDiagnostics(async () => { calls++; throw error; }, undefined));
  assert.equal(calls, 1);
});

test("HTTP200 body error retains safe diagnostics even without debug dump", async () => {
  const { fetchProviderResponse, withProviderExchangeDump } = await import("../../src/llm/provider/providerExchangeDump.ts");
  const { setFetchImplementationForTests } = await import("../../src/services/proxy/index.ts");
  const { createTestAppConfig } = await import("../helpers/config-fixtures.tsx");
  const { default: pino } = await import("pino");
  const config = createTestAppConfig();
  const failure = Object.assign(new Error("private body"), { code: "UND_ERR_SOCKET" });
  let calls = 0;
  setFetchImplementationForTests(async () => {
    calls++;
    return new Response(new ReadableStream({ pull(controller) { controller.error(failure); } }), { status: 200 });
  });
  try {
    await assert.rejects(withProviderExchangeDump({ config, modelRef: "test", model: "test", logger: pino({level:"silent"}) }, true, async () => {
      const response = await fetchProviderResponse(config, "llm", "https://example.test", {});
      await response.text();
    }));
    assert.equal(calls, 1);
    assert.equal(getRequestDiagnostic(failure)?.stage, "body");
    assert.equal(getRequestDiagnostic(failure)?.statusCode, 200);
  } finally { setFetchImplementationForTests(null); }
});

test("unknown permanent code mixed with temporary code rejects retry", async () => {
  let calls = 0;
  const failure = new AggregateError([Object.assign(new Error(), { code: "ECONNREFUSED" }), Object.assign(new Error(), { code: "UNKNOWN_AUTH_FAILURE" })]);
  await assert.rejects(requestWithDiagnostics(async () => { calls++; throw failure; }, undefined));
  assert.equal(calls, 1);
});

test("first-token timeout after HTTP200 preserves status and safe timeout message", async () => {
  const { fetchProviderResponse, withProviderExchangeDump } = await import("../../src/llm/provider/providerExchangeDump.ts");
  const { setFetchImplementationForTests } = await import("../../src/services/proxy/index.ts");
  const { createTestAppConfig } = await import("../helpers/config-fixtures.tsx");
  const { default: pino } = await import("pino");
  const config = createTestAppConfig();
  let calls = 0;
  const failure = new Error("LLM first token timeout after 10ms");
  setFetchImplementationForTests(async () => { calls++; return new Response("", { status: 200 }); });
  try {
    await assert.rejects(withProviderExchangeDump({ config, modelRef: "test", model: "test", logger: pino({level:"silent"}) }, true, async () => {
      await fetchProviderResponse(config, "llm", "https://example.test", {});
      throw failure;
    }));
    assert.equal(calls, 1);
    assert.equal(getRequestDiagnostic(failure)?.stage, "response");
    assert.equal(getRequestDiagnostic(failure)?.statusCode, 200);
    assert.equal(getRequestDiagnostic(failure)?.willRetry, false);
    const filtered = filterLogContent({ error: { message: failure.message }, requestDiagnostic: getRequestDiagnostic(failure) });
    assert.equal((filtered.error as {message: string}).message, failure.message);
  } finally { setFetchImplementationForTests(null); }
});

test("image exchange never retries while chat retries connect refusal once", async () => {
  const { fetchProviderResponse, withProviderExchangeDump } = await import("../../src/llm/provider/providerExchangeDump.ts");
  const { setFetchImplementationForTests } = await import("../../src/services/proxy/index.ts");
  const { createTestAppConfig } = await import("../helpers/config-fixtures.tsx");
  const { default: pino } = await import("pino");
  const config = createTestAppConfig();
  for (const kind of ["image", "chat"] as const) {
    let calls = 0;
    setFetchImplementationForTests(async () => { calls++; throw Object.assign(new Error("private"), {code:"ECONNREFUSED"}); });
    try {
      await assert.rejects(withProviderExchangeDump({ config, modelRef: "test", model: "test", logger: pino({level:"silent"}) }, true, () => fetchProviderResponse(config, "llm", "https://example.test", {}), kind));
      assert.equal(calls, kind === "image" ? 1 : 2);
    } finally { setFetchImplementationForTests(null); }
  }
});

test("image transport wrapper retains safe metadata for serialized tool results", async () => {
  const { imageTransportFailure } = await import("../../src/services/images/imageGenerationError.ts");
  const failure = Object.assign(new Error("private URL"), {code:"UND_ERR_SOCKET"});
  await assert.rejects(requestWithDiagnostics(async () => {throw failure;}, undefined, undefined, false));
  const wrapped = imageTransportFailure(failure, "request", "test", []);
  assert.equal(getRequestDiagnostic(wrapped)?.stage, "connect");
  const detail = JSON.parse(JSON.stringify(wrapped.details));
  assert.deepEqual(detail.requestDiagnostic.causeCodes, ["UND_ERR_SOCKET"]);
  assert.equal(JSON.stringify(detail.requestDiagnostic).includes("private"), false);
});

test("untrusted tool metadata projection cannot leak bodies, URLs or arbitrary codes", async () => {
  const { diagnosticFromToolResult } = await import("../../src/llm/provider/requestDiagnostics.ts");
  const result = diagnosticFromToolResult(JSON.stringify({detail:{requestDiagnostic:{requestId:"00000000-0000-0000-0000-000000000000",stage:"body",statusCode:200,causeCodes:["UND_ERR_SOCKET","secret"],body:"secret",url:"secret",message:"secret"}}}));
  assert.equal(JSON.stringify(result).includes("secret"),false);
  assert.deepEqual(result?.causeCodes,["UND_ERR_SOCKET"]);
  assert.equal(diagnosticFromToolResult("invalid-json"),undefined);
});

test("nested image scope cannot inherit chat retry permission without a logger", async () => {
  const { fetchProviderResponse, withProviderExchangeDump } = await import("../../src/llm/provider/providerExchangeDump.ts");
  const { setFetchImplementationForTests } = await import("../../src/services/proxy/index.ts");
  const { createTestAppConfig } = await import("../helpers/config-fixtures.tsx");
  const { default: pino } = await import("pino");
  const config=createTestAppConfig(); let calls=0;
  setFetchImplementationForTests(async () => {calls++;throw Object.assign(new Error(),{code:"ECONNREFUSED"});});
  try {
    await assert.rejects(withProviderExchangeDump({config,modelRef:"test",model:"test",logger:pino({level:"silent"})},true,()=>withProviderExchangeDump({config,modelRef:"test",model:"test"},true,()=>fetchProviderResponse(config,"llm","https://example.test",{}),"image")));
    assert.equal(calls,1);
  } finally {setFetchImplementationForTests(null);}
});

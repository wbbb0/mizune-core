import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { MediaInspectionService } from "../../../src/services/workspace/mediaInspectionService.ts";
import { createLlmTestConfig, withMockFetch } from "../../helpers/llm-test-support.tsx";

type Protocol = "google" | "vertex" | "vertex_express" | "anthropic" | "dashscope" | "openai_compatible";

const answer = JSON.stringify({
  status: "answered",
  found: true,
  answer: "可见角色为银色长发，穿蓝色外套。",
  visibleContentSummary: null,
  nearMatches: [],
  confidenceNotes: []
});

function payloads(protocol: Protocol, reason?: string): Record<string, unknown>[] {
  switch (protocol) {
    case "google":
    case "vertex":
    case "vertex_express":
      return [
        { candidates: [{ content: { parts: [{ text: answer }] } }] },
        { candidates: [{ ...(reason ? { finishReason: reason } : {}) }] }
      ];
    case "anthropic":
      return [
        { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: answer } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { ...(reason ? { stop_reason: reason } : {}) } },
        { type: "message_stop" }
      ];
    case "dashscope":
      return [
        { output: { choices: [{ message: { content: answer } }] } },
        { output: { choices: [{ ...(reason ? { finish_reason: reason } : {}) }] } }
      ];
    case "openai_compatible":
      return [
        { choices: [{ delta: { content: answer } }] },
        { choices: [{ delta: {}, ...(reason ? { finish_reason: reason } : {}) }] }
      ];
  }
}

async function inspect(protocol: Protocol, reason?: string, conflictingReason?: string) {
  const config = createLlmTestConfig({ chat: { capabilities: { supportsVision: true } } });
  config.llm.providers.test!.type = protocol;
  config.llm.imageInspector.enabled = true;
  const logger = pino({ level: "silent" });
  const inspector = new MediaInspectionService(config, new LlmClient(config, logger), logger);
  let result!: Awaited<ReturnType<MediaInspectionService["inspectPreparedMedia"]>>;
  const chunks = payloads(protocol, reason);
  if (conflictingReason) chunks.push({ candidates: [{ finishReason: conflictingReason }] });
  // Keep the actual terminal metadata: the shared SSE helper otherwise adds STOP.
  const scenario = protocol === "google" || protocol === "vertex" || protocol === "vertex_express"
    ? { response: new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }) }
    : { payloads: chunks };
  await withMockFetch([{ assertRequest() {}, ...scenario }], async () => {
    result = await inspector.inspectPreparedMedia({
      question: "读取角色可见外观",
      media: [{ mediaId: "file_synthetic", inputUrl: "data:image/png;base64,aGVsbG8=" }]
    });
  });
  return result;
}

for (const [protocol, reason, expected] of [
  ["google", "STOP", "completed"],
  ["vertex", "STOP", "completed"],
  ["vertex", "MAX_TOKENS", "truncated"],
  ["vertex", undefined, "unknown"],
  ["vertex", "FUTURE_UNRECOGNIZED_REASON", "unknown"],
  ["vertex_express", "STOP", "completed"],
  ["vertex_express", "MAX_TOKENS", "truncated"],
  ["vertex_express", undefined, "unknown"],
  ["vertex_express", "FUTURE_UNRECOGNIZED_REASON", "unknown"],
  ["anthropic", "end_turn", "completed"],
  ["anthropic", "max_tokens", "truncated"],
  ["anthropic", "model_context_window_exceeded", "truncated"],
  ["anthropic", undefined, "unknown"],
  ["anthropic", "future_unrecognized_reason", "unknown"],
  ["dashscope", "stop", "completed"],
  ["dashscope", "length", "truncated"],
  ["dashscope", undefined, "unknown"],
  ["dashscope", "future_unrecognized_reason", "unknown"],
  ["openai_compatible", "stop", "completed"],
  ["openai_compatible", "length", "truncated"],
  ["openai_compatible", undefined, "unknown"]
] as const) {
  test(`${protocol} preserves completion status ${String(reason)} through LlmClient and media inspection`, async () => {
    const result = await inspect(protocol, reason);
    assert.equal(result.ok, true);
    assert.equal(result.results[0]?.status, "answered");
    assert.equal(result.results[0]?.parseStatus, "parsed");
    assert.equal(result.results[0]?.completionStatus, expected);
  });
}

for (const protocol of ["google", "vertex", "vertex_express"] as const) {
  for (const reason of [
    "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
    "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
    "OTHER", "LANGUAGE", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL",
    "TOO_MANY_TOOL_CALLS", "NO_IMAGE", "IMAGE_OTHER"
  ]) {
    test(`${protocol} ${reason} rejects even complete JSON already received before terminal failure`, async () => {
      const result = await inspect(protocol, reason);
      assert.equal(result.ok, false);
      assert.equal(result.results[0]?.status, "error");
      assert.equal(result.results[0]?.found, null);
      assert.match(result.results[0]?.answer ?? "", new RegExp(reason));
    });
  }
}

for (const protocol of ["google", "vertex", "vertex_express"] as const) {
  test(`${protocol} rejects conflicting terminal reasons instead of upgrading truncated content`, async () => {
    const result = await inspect(protocol, "MAX_TOKENS", "STOP");
    assert.equal(result.ok, false);
    assert.equal(result.results[0]?.status, "error");
    assert.match(result.results[0]?.answer ?? "", /流终态冲突/);
  });
}

for (const reason of [undefined, "MAX_TOKENS", "FUTURE_UNRECOGNIZED_REASON"]) {
  test(`Google SDK requires STOP and rejects ${String(reason)} even after complete JSON`, async () => {
    const result = await inspect("google", reason);
    assert.equal(result.ok, false);
    assert.equal(result.results[0]?.status, "error");
    assert.equal(result.results[0]?.found, null);
    assert.match(result.results[0]?.answer ?? "", /未正常完成/);
  });
}

for (const [protocol, reason] of [
  ["anthropic", "refusal"],
  ["anthropic", "pause_turn"],
  ["dashscope", "content_filter"],
  ["dashscope", "error"]
] as const) {
  test(`${protocol} ${reason} rejects before valid partial JSON can become inspection success`, async () => {
    const result = await inspect(protocol, reason);
    assert.equal(result.ok, false);
    assert.equal(result.results[0]?.status, "error");
    assert.match(result.results[0]?.answer ?? "", new RegExp(reason));
  });
}

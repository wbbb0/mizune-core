import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { StructuredSuggestionService } from "../../../src/llm/structured/structuredSuggestionService.ts";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { scenarioHostToolHandlers } from "../../../src/modes/scenarioHost/tools.ts";
import type { BuiltinToolContext } from "../../../src/llm/tools/core/shared.ts";
import { createLlmTestConfig, withMockFetch } from "../../helpers/llm-test-support.tsx";

const logger = pino({ level: "silent" });
const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false };
const request = { taskName: "test.labels", instruction: "生成中文标签", context: { description: "简短描述" }, outputContract: '{"label":"string"}', outputSchema: schema };
function officialConfig() {
  const config = createLlmTestConfig();
  config.llm.providers.test!.type = "openai";
  config.llm.models.main!.chat!.capabilities.supportsStructuredOutput = true;
  return config;
}
function output(text: string) {
  return [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }] } }];
}

test("structured suggestions pass the supplied schema through LlmClient to native Responses", async () => {
  const config = officialConfig();
  const service = new StructuredSuggestionService(config, new LlmClient(config, logger), logger);
  await withMockFetch([{
    assertRequest(body: any) {
      assert.deepEqual(body.text.format, { type: "json_schema", name: "suggestion", strict: true, schema });
      assert.equal(body.store, false);
      assert.match(body.input[1].content[0].text, /生成中文标签/);
    },
    payloads: output('{"label":"测试标签"}')
  }], async () => {
    const result = await service.suggestObject(request);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { label: "测试标签" });
    assert.equal(result.rawAnswer, '{"label":"测试标签"}');
  });
});

test("structured suggestions without a schema request native JSON mode", async () => {
  const config = officialConfig();
  const service = new StructuredSuggestionService(config, new LlmClient(config, logger), logger);
  const { outputSchema: _schema, ...withoutSchema } = request;
  await withMockFetch([{
    assertRequest(body: any) { assert.deepEqual(body.text.format, { type: "json_object" }); },
    payloads: output('{"label":"测试标签"}')
  }], async () => {
    assert.equal((await service.suggestObject(withoutSchema)).ok, true);
  });
});

test("mixed suggestion routes retain text parsing and can fall back to a non-native provider", async () => {
  const config = officialConfig();
  config.llm.providers.google_fallback = { ...config.llm.providers.test!, type: "google" };
  config.llm.models.fallback = { ...config.llm.models.main!, provider: "google_fallback" };
  config.llm.routingPresets.test!.mainSmall = ["main", "fallback"];
  const service = new StructuredSuggestionService(config, new LlmClient(config, logger), logger);
  await withMockFetch([{
    assertRequest(body: any) { assert.equal(body.text?.format, undefined); },
    response: new Response("upstream busy", { status: 503 })
  }, {
    assertRequest(body: any) { assert.equal(body.generationConfig.responseSchema, undefined); },
    payloads: [{ candidates: [{ content: { parts: [{ text: '```json\n{"label":"备用标签"}\n```' }] } }] }]
  }], async () => {
    const result = await service.suggestObject(request);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { label: "备用标签" });
  });
});

function assertStrictObjects(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(assertStrictObjects); return; }
  const record = value as Record<string, unknown>;
  if (record.type === "object") {
    assert.equal(record.additionalProperties, false);
    const properties = record.properties as Record<string, unknown>;
    assert.deepEqual([...(record.required as string[])].sort(), Object.keys(properties).sort());
  }
  Object.values(record).forEach(assertStrictObjects);
}

test("scenario equipment suggestions supply a strict nested schema end to end", async () => {
  const config = officialConfig();
  const service = new StructuredSuggestionService(config, new LlmClient(config, logger), logger);
  const context = {
    config,
    lastMessage: { sessionId: "schema-test" },
    sessionManager: { getModeId: () => "scenario_host" },
    structuredSuggestionService: service
  } as unknown as BuiltinToolContext;
  const equipment = { wornItems: [{ name: "外套", wearPosition: "上身", description: "轻便" }], heldItems: [{ name: "手电", description: "小巧", quantity: 1 }] };
  await withMockFetch([{
    assertRequest(body: any) {
      const format = body.text.format;
      assert.equal(format.type, "json_schema");
      assert.equal(format.strict, true);
      assertStrictObjects(format.schema);
      assert.equal(format.schema.properties.heldItems.items.properties.quantity.type, "integer");
    },
    payloads: output(JSON.stringify(equipment))
  }], async () => {
    const result = JSON.parse(String(await scenarioHostToolHandlers.suggest_scenario_details!({ id: "suggest", type: "function", function: { name: "suggest_scenario_details", arguments: "{}" } }, { task: "character_equipment", description: "给远足人物生成装备" }, context)));
    assert.equal(result.ok, true);
    assert.deepEqual(result.wornItems, equipment.wornItems);
    assert.deepEqual(result.heldItems, equipment.heldItems);
  });
});

test("compatible suggestions do not send native format parameters when model support is unknown", async () => {
  for (const type of ["openai_compatible", "openai_responses_compatible"] as const) {
    const config = officialConfig();
    config.llm.providers.test!.type = type;
    delete config.llm.models.main!.chat!.capabilities.supportsStructuredOutput;
    const client = new LlmClient(config, logger);
    assert.equal(client.supportsStructuredOutput(["main"]), false);
    const service = new StructuredSuggestionService(config, client, logger);
    await withMockFetch([{
      assertRequest(body: any) {
        assert.equal(body.response_format, undefined);
        assert.equal(body.text?.format, undefined);
      },
      payloads: type === "openai_compatible" ? [{ choices: [{ delta: { content: '{"label":"兼容标签"}' }, finish_reason: "stop" }] }] : output('{"label":"兼容标签"}')
    }], async () => {
      const result = await service.suggestObject(request);
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, { label: "兼容标签" });
    });
  }
});

test("automatic structured output requires both model and protocol support for every candidate", () => {
  const config = officialConfig();
  const client = new LlmClient(config, logger);
  assert.equal(client.supportsStructuredOutput(["main"]), true);
  config.llm.models.main!.chat!.capabilities.supportsStructuredOutput = false;
  assert.equal(client.supportsStructuredOutput(["main"]), false);
  config.llm.models.main!.chat!.capabilities.supportsStructuredOutput = true;
  config.llm.models.unknown = structuredClone(config.llm.models.main!);
  delete config.llm.models.unknown!.chat!.capabilities.supportsStructuredOutput;
  assert.equal(client.supportsStructuredOutput(["main", "unknown"]), false);
  config.llm.models.unknown!.chat!.capabilities.supportsStructuredOutput = true;
  config.llm.providers.google_fallback = { ...config.llm.providers.test!, type: "google" };
  config.llm.models.unknown!.provider = "google_fallback";
  assert.equal(client.supportsStructuredOutput(["main", "unknown"]), false);
  assert.equal(client.supportsStructuredOutput([]), false);
});

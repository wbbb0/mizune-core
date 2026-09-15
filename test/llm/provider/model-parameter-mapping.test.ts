import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenAiCompatibleModelApiParameters, buildOpenAiResponsesModelApiParameters, buildDashScopeModelApiParameters, buildGeminiGenerationConfigParameters, buildLmStudioNativeModelApiParameters } from "#llm/provider/modelApiParameters.ts";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import { normalizeLlmCatalog } from "#llm/shared/modelTarget.ts";
import { VertexAiProvider } from "#llm/provider/providers/vertexAiProvider.ts";

test("output token limit maps to each protocol and overrides advanced values", () => {
  for (const [build, target] of [
    [buildOpenAiCompatibleModelApiParameters, "max_tokens"],
    [buildOpenAiResponsesModelApiParameters, "max_output_tokens"],
    [buildDashScopeModelApiParameters, "max_tokens"],
    [buildGeminiGenerationConfigParameters, "maxOutputTokens"],
    [buildLmStudioNativeModelApiParameters, "max_output_tokens"]
  ] as const) {
    const context = { modelProfile: { apiParameters: { maxOutputTokens: 512, temperature: 0.7, extra: { [target]: 123, custom: "保留" } } } } as any;
    assert.deepEqual(build(context), { [target]: 512, temperature: 0.7, custom: "保留" });
    context.modelProfile.apiParameters = {};
    assert.deepEqual(build(context), {});
  }
});

test("provider schemas offer applicable sampling parameters and reject invalid numeric values", () => {
  const meta = llmCatalogFileSchema.toMeta() as any;
  const parameters = (type: string) => meta.value.options.find((o: any) => o.fields.type.schema.value === type).fields.models.schema.value.fields.apiParameters.schema.fields;
  assert.ok(parameters("lmstudio").min_p);
  assert.equal(parameters("google").min_p, undefined);
  assert.equal(parameters("anthropic").presence_penalty, undefined);
  assert.equal(parameters("openai_responses").top_k, undefined);
  assert.equal(parameters("deepseek").top_k, undefined);
  for (const value of [0, -1, 1.5]) {
    assert.throws(() => llmCatalogFileSchema.parseFromObject({ p: { type: "google", models: { m: { upstreamModel: "m", apiParameters: { maxOutputTokens: value } } } } }));
  }
});

test("Vertex builds project endpoints with explicit URL taking precedence", () => {
  const provider = new VertexAiProvider();
  for (const location of ["global", "us-central1"]) {
    const catalog = llmCatalogFileSchema.parseFromObject({ v: { type: "vertex", projectId: "my-project", location, models: {} } });
    const p = normalizeLlmCatalog(catalog).providers.v!;
    const host = location === "global" ? "aiplatform.googleapis.com" : "us-central1-aiplatform.googleapis.com";
    assert.equal(provider.resolveBaseUrl(p), `https://${host}/v1/projects/my-project/locations/${location}/publishers/google`);
    p.baseUrl = "https://gateway.example/vertex";
    assert.equal(provider.resolveBaseUrl(p), p.baseUrl);
  }
  assert.throws(() => llmCatalogFileSchema.parseFromObject({ v: { type: "vertex", models: {} } }));
  assert.throws(() => llmCatalogFileSchema.parseFromObject({ v: { type: "vertex", projectId: "p", location: "invalid/path" } }));
});


test("OpenAI compatible output limit supports selecting the completion token field", () => {
  const context = { providerConfig: { type: "openai", maxOutputTokenField: "max_completion_tokens" }, modelProfile: { apiParameters: { maxOutputTokens: 256 } } } as any;
  assert.deepEqual(buildOpenAiCompatibleModelApiParameters(context), { max_completion_tokens: 256 });
});

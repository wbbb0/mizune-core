import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import sharp from "sharp";
import { loadConfig } from "#config/config.ts";
import { LlmClient } from "#llm/llmClient.ts";
import { GoogleAiStudioProvider } from "#llm/provider/providers/googleAiStudioProvider.ts";
import { listProviderModelSlots } from "#llm/provider/modelListDiscovery.ts";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import type { LlmMessage, LlmProviderRequestContext } from "#llm/provider/providerTypes.ts";

const config = loadConfig();
const modelRef = process.env.GOOGLE_SMOKE_MODEL;
if (!modelRef) throw new Error("请用 GOOGLE_SMOKE_MODEL 显式选择已配置的 Google 聊天模型");
const profile = config.llm.models[modelRef];
if (!profile?.chat) throw new Error("指定模型没有 chat 用途");
if (process.env.GOOGLE_SMOKE_THINKING_BUDGET !== undefined) {
  const budget = Number(process.env.GOOGLE_SMOKE_THINKING_BUDGET);
  if (!Number.isSafeInteger(budget) || budget < -1) throw new Error("无效的 smoke 思考预算");
  profile.chat.googleThinking = { mode: "budget", budget };
}
const providerConfig = config.llm.providers[profile.provider];
if (providerConfig?.type !== "google") throw new Error("仅允许 Google AI Studio 模型");
// Test JSON and local functions separately from the native-search combination.
profile.chat.searchEnabled = false;
const temporary = await mkdtemp(join(tmpdir(), "llm-google-smoke-"));
config.dataDir = temporary;
config.llm.debugDump.enabled = false;
const logger = pino({ level: "silent" });
const provider = new GoogleAiStudioProvider();
const context: LlmProviderRequestContext = { config, logger, modelRef, model: profile.model, modelProfile: profile, providerName: profile.provider, providerConfig, baseUrl: provider.resolveBaseUrl(providerConfig)!, candidateIndex: 0 };
const client = new LlmClient(config, logger);
const common = { modelRefOverride: modelRef, skipDebugDump: true, enableThinkingOverride: false, maxOutputTokensOverride: 4096, timeoutMsOverride: 90000 };
const report: Array<Record<string, unknown>> = [];
async function run(name: string, action: () => Promise<Record<string, unknown>>) {
  const started = Date.now();
  try { const detail = await action(); const row = { name, passed: true, elapsedMs: Date.now() - started, ...detail }; report.push(row); console.log(JSON.stringify(row)); }
  catch (error) { const row = { name, passed: false, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error), statusCode: (error as { statusCode?: number })?.statusCode }; report.push(row); console.log(JSON.stringify(row)); }
}
try {
  await run("models.list", async () => {
    const provider = llmCatalogFileSchema.parse({ selected: { type: "google", apiKey: providerConfig.apiKey, proxy: providerConfig.proxy, baseUrl: context.baseUrl, models: {} } }).selected!;
    const result = await listProviderModelSlots({ config, provider, fetchTimeoutMs: 30000 });
    assert.equal(result.kind, "ok");
    return { modelCount: result.kind === "ok" ? result.models.length : 0 };
  });
  await run("json_schema", async () => {
    const result = await client.generate({ ...common, messages: [{ role: "user", content: "请返回 value 等于 7 的 JSON 对象。" }], responseFormat: { type: "json_schema", name: "result", schema: { type: "object", properties: { value: { type: "integer", const: 7 } }, required: ["value"], additionalProperties: false } } });
    assert.deepEqual(JSON.parse(result.text), { value: 7 }); return { text: result.text };
  });
  await run("parallel_tools_and_replay", async () => {
    const history: LlmMessage[] = [{ role: "user", content: "请在同一轮并行调用 lookup 两次，分别查询编号 A 和 B。必须两个调用都完成后，回答结果总和。不要自己猜结果。" }];
    const seen: string[] = [];
    let parallel = false;
    const result = await client.generate({ ...common, messages: history,
      tools: [{ type: "function", function: { name: "lookup", description: "查询公开合成测试编号的整数值。", parameters: { type: "object", properties: { code: { type: "string", enum: ["A", "B"] } }, required: ["code"], additionalProperties: false } } }],
      onAssistantToolCalls(message) { history.push(structuredClone(message)); if ((message.tool_calls?.length ?? 0) >= 2) parallel = true; },
      toolExecutor: async call => { const { code } = JSON.parse(call.function.arguments); seen.push(code); return JSON.stringify({ code, value: code === "A" ? 17 : 25 }); },
      onToolResultMessage(message) { history.push(structuredClone(message)); }
    });
    assert.deepEqual([...seen].sort(), ["A", "B"]); assert.equal(parallel, true); assert.match(result.text, /42/);
    history.push({ role: "assistant", content: result.text, ...(result.assistantMetadata ? { providerMetadata: result.assistantMetadata } : {}) }, { role: "user", content: "根据刚才已经执行的结果，A 的值是多少？只回答数字，不要再次调用工具。" });
    const next = await client.generate({ ...common, messages: history }); assert.match(next.text, /17/);
    return { calls: seen.length, parallel, result: result.text, followup: next.text };
  });
  if (profile.chat.capabilities.supportsVision && profile.chat.capabilities.supportsVideoInput) await run("animated_video", async () => {
    const frames = await Promise.all(["red", "blue"].map(background => sharp({ create: { width: 64, height: 64, channels: 3, background } }).png().toBuffer()));
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [1000, 1000], loop: 0 }).toBuffer();
    const result = await client.generate({ ...common, messages: [{ role: "user", content: [{ type: "text", text: "按时间顺序列出动画中出现的纯色，只回答颜色。" }, { type: "image_url", image_url: { url: `data:image/gif;base64,${gif.toString("base64")}` } }] }] });
    assert.match(result.text, /红[\s\S]*蓝/); return { text: result.text };
  });
  if (profile.chat.capabilities.supportsSearch) await run("native_search_citations", async () => {
    profile.chat!.searchEnabled = true;
    const result = await client.generate({ ...common, messages: [{ role: "user", content: "请使用 Google 搜索查阅 Google Gemini API 官方文档，简要回答当前文档推荐的 JavaScript SDK 包名并附来源。" }] });
    assert.match(result.text, /参考来源/); return { text: result.text };
  });
} finally { await rm(temporary, { recursive: true, force: true }); }
console.log(JSON.stringify({ modelRef, passed: report.every(row => row.passed), checks: report.length }));
if (report.some(row => !row.passed)) process.exitCode = 1;

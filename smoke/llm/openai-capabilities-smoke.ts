import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { parseArgs } from "node:util";
import pino from "pino";
import { loadConfig } from "../../src/config/config.ts";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { generateConfiguredImage } from "../../src/services/images/imageGeneration.ts";
import type { ModelOperation } from "../../src/config/modelOperations.ts";
import { fromCanonicalModelRef } from "../../src/llm/shared/modelTarget.ts";

const { values } = parseArgs({ options: {
  instance: { type: "string", default: "acc1" },
  provider: { type: "string", default: "openai_official" },
  capability: { type: "string", default: "responses" },
  "audio-file": { type: "string" }
} });
const allowed = ["responses", "search", "embedding", "transcription", "speech", "image", "decision"] as const;
type Capability = typeof allowed[number];
if (values.capability !== "all" && !allowed.includes(values.capability as Capability)) throw new Error(`capability 须为 all 或 ${allowed.join(", ")}`);
const selected: readonly Capability[] = values.capability === "all" ? allowed : [values.capability as Capability];
const config = loadConfig({ ...process.env, CONFIG_INSTANCE: values.instance });
const provider = config.llm.providers[values.provider];
if (!provider || provider.type !== "openai" || !provider.apiKey) throw new Error(`请在 llm.catalog.yml 配置 ${values.provider} 官方供应商及 API Key，再执行真实接口验证`);
const operations: Record<Capability, ModelOperation> = { responses: "chat", search: "chat", embedding: "embedding", transcription: "transcription", speech: "speech", image: "image", decision: "decision" };
const refs = new Map<Capability, string>();
for (const capability of selected) {
  const target = Object.entries(config.llm.models).find(([, model]) => model.provider === values.provider && model[operations[capability]]
    && (capability !== "search" || model.chat?.capabilities.supportsSearch === true));
  if (!target) throw new Error(`供应商 ${values.provider} 缺少 ${capability} 用途模型，尚未发送任何请求`);
  refs.set(capability, target[0]);
}
if (selected.includes("transcription") && !selected.includes("speech") && !values["audio-file"]) throw new Error("单独转写验证需要 --audio-file 指定公开测试音频");
const temporary = await mkdtemp(join(tmpdir(), "openai-capabilities-smoke-"));
try {
  config.dataDir = temporary;
  config.localFiles.root = temporary;
  config.chatFiles.root = "assets";
  config.llm.enabled = true;
  config.llm.debugDump.enabled = false;
  // Smoke 请求只验证一次；工具轮次与协议恢复分别限制，防止隐式重复计费。
  config.llm.toolCallMaxIterations = 1;
  config.llm.toolCallProtocolRecoveryMaxAttempts = 1;
  const client = new LlmClient(config, pino({ level: "silent" }));
  const report: Record<string, unknown> = {};
  let generatedAudio: Buffer | undefined;
  // Speech precedes transcription so all uses its own public test audio, without reading instance data.
  const order: Capability[] = ["responses", "search", "embedding", "speech", "transcription", "image", "decision"];
  for (const capability of order.filter(item => selected.includes(item))) {
    const modelRef = refs.get(capability)!;
    const startedAt = Date.now();
    switch (capability) {
      case "responses": {
        const result = await client.generate({ modelRefOverride: modelRef, skipDebugDump: true,
          responseFormat: { type: "json_schema", name: "smoke", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
          messages: [{ role: "user", content: "请返回 JSON 对象，ok 为 true。" }] });
        if (JSON.parse(result.text).ok !== true) throw new Error("Responses 结构化输出不符合契约");
        break;
      }
      case "search": {
        config.llm.models[modelRef]!.chat!.searchEnabled = true;
        const result = await client.generate({ modelRefOverride: modelRef, skipDebugDump: true,
          messages: [{ role: "user", content: "请使用联网搜索查找 OpenAI 官方 Responses API 文档，并提供来源链接。" }] });
        if (!Array.isArray(result.assistantMetadata?.citations) || !result.assistantMetadata.citations.length) throw new Error("搜索未返回可验证的引用来源");
        break;
      }
      case "embedding": {
        const target = fromCanonicalModelRef(modelRef);
        if (!target) throw new Error("向量模型引用缺少供应商与模型身份");
        config.context.embedding.model = target;
        const result = await client.embedTexts({ texts: ["公开接口验证文本。"], modelRefOverride: modelRef });
        if (result.vectors.length !== 1 || !result.vectors[0]?.length) throw new Error("未返回向量");
        break;
      }
      case "speech": {
        const result = await client.synthesize({ text: "你好，这是一段人工智能生成的接口测试语音。", format: "wav", modelRefOverride: modelRef, skipDebugDump: true });
        generatedAudio = result.buffer;
        report.speech = { bytes: result.buffer.length };
        break;
      }
      case "transcription": {
        const file = values["audio-file"];
        const buffer = generatedAudio ?? await readFile(file!);
        const format = generatedAudio ? "wav" : extname(file!).slice(1).toLowerCase();
        const result = await client.transcribe({ audio: { data: buffer.toString("base64"), format }, modelRefOverride: modelRef, skipDebugDump: true });
        if (!result.text.trim()) throw new Error("转写为空");
        break;
      }
      case "image": {
        config.llm.imageGeneration.enabled = true;
        config.chatFiles.enabled = true;
        config.llm.routingPreset = "openai_smoke";
        config.llm.routingPresets.openai_smoke = { imageGenerator: [modelRef] };
        const image = await generateConfiguredImage(config, { prompt: "纯白背景上一颗蓝色圆球，简洁插画，无文字。" });
        report.image = { width: image.width, height: image.height, bytes: image.buffer.length };
        break;
      }
      case "decision": {
        const result = await client.decide({ modelRefOverride: modelRef, skipDebugDump: true, input: "这是一段接口测试文本。", questions: [{ name: "test", type: "predicate", instructions: "这段文本是否说明自己是接口测试？" }] });
        if (result.answers[0]?.type !== "predicate") throw new Error("决策未返回条件概率");
        break;
      }
    }
    report[capability] = { ...(report[capability] as Record<string, unknown> ?? {}), ok: true, modelRef, elapsedMs: Date.now() - startedAt };
    process.stdout.write(JSON.stringify({ capability, ...(report[capability] as Record<string, unknown>) }) + "\n");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

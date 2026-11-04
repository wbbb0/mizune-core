import { generateHistorySummary } from "../../src/conversation/historySummaryGeneration.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "#config/config.ts";
import { LlmClient } from "#llm/llmClient.ts";
import { getRequestDiagnostic } from "#llm/provider/requestDiagnostics.ts";

// 只载入连接配置；不创建服务、不读取会话，单个候选防止 fallback 放大费用。
const config = loadConfig({ ...process.env, CONFIG_INSTANCE: process.env.CONFIG_INSTANCE ?? "acc2" });
const selected = Object.entries(config.llm.models).find(([ref, model]) => /gpt.*6[._-]?1.*sol/i.test(`${ref} ${model.model}`));
if (!selected) throw new Error("未找到 sol 模型配置");
if (process.env.SMOKE_UNCONTROLLABLE === "1" && selected[1].chat) selected[1].chat.capabilities.thinkingControllable = false;
const temporary = await mkdtemp(join(tmpdir(), "llm-request-smoke-"));
config.dataDir = temporary;
const client = new LlmClient(config, pino({ level: "silent" }));
try {
  const large = process.env.SMOKE_LARGE === "1";
  for (const name of large ? ["large"] : process.env.SMOKE_COMPRESSION === "1" ? ["compression"] : ["small", "stream", "compression"]) {
    const started = Date.now();
    let chunks = 0;
    try {
      const content = name === "large"
        ? "以下是合成记录。请只回答收到。\n" + "record A123 status normal. ".repeat(18690)
        : name === "compression" ? "请压缩以下合成对话为简短记忆：用户计划周六整理书架。助手建议先分类。用户接受。" : "请只回答收到。";
      const result = name === "compression" ? { text: await generateHistorySummary({ config, llmClient: { generate: params => client.generate({ ...params, modelRefOverride: selected[0], maxOutputTokensOverride: 256 }) }, prompt: { sessionId: "synthetic-smoke", existingSummary: null, messagesToCompress: [{ role: "user", content, timestampMs: 1 }] } }), usage: undefined } : await client.generate({ modelRefOverride: selected[0], enableThinkingOverride: true, messages: [{ role: "user", content }], maxOutputTokensOverride: 128, skipDebugDump: true, ...(name === "stream" ? { onTextDelta: () => { chunks++; } } : {}) });
      console.log(JSON.stringify({ case: name, modelRef: selected[0], elapsedMs: Date.now() - started, passed: true, outputCharacters: result.text.length, chunks, usage: result.usage }));
    } catch (error) {
      console.log(JSON.stringify({ case: name, modelRef: selected[0], elapsedMs: Date.now() - started, passed: false, diagnostic: getRequestDiagnostic(error), errorName: error instanceof Error ? error.name : "unknown", safeHints: error instanceof Error ? ["max_tokens", "max_output_tokens", "temperature", "stream", "unsupported", "minimum", "reasoning", "tool", "thinking", "reasoning.effort", "none", "minimal", "low", "medium", "high", "xhigh"].filter(term => error.message.toLowerCase().includes(term)) : [] }));
    }
  }
} finally { await rm(temporary, { recursive: true, force: true }); }

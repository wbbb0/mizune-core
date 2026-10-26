import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "#llm/llmClient.ts";
import { resolveModelRequestBudget, estimateRequestTokens, ModelRequestBudgetError } from "#llm/shared/requestTokenBudget.ts";
import { prepareGenerationRequestBudget } from "#app/generation/generationRequestBudget.ts";
import { migrateRoutingPresetContextBudgets } from "#config/contextBudgetMigration.ts";
import { generateHistorySummary } from "#conversation/historySummaryGeneration.ts";
import { createLlmTestConfig, createToolDefinition, withMockFetch } from "../helpers/llm-test-support.tsx";
const logger = pino({ level: "silent" });

test("总上下文取最终 min，并扣除输出和安全余量，独立遵守输入硬限制", () => {
  const config = createLlmTestConfig({ chat: { limits: { contextTokens: 20000, maxInputTokens: 15000, maxOutputTokens: 3000 }, defaults: { maxOutputTokens: 5000 } } });
  assert.deepEqual(resolveModelRequestBudget(config.llm.models.main!, 10000), { contextTokens: 10000, inputTokens: 6800, outputTokens: 3000, safetyTokens: 200 });
  assert.equal(resolveModelRequestBudget(config.llm.models.main!, 30000).inputTokens, 15000);
  assert.throws(() => resolveModelRequestBudget(config.llm.models.main!, 2000), ModelRequestBudgetError);
});

test("旧预设显式迁移且新字段优先，不修改来源数据", () => {
  const raw = { default: { tokenLimits: { triggerTokens: 200000, retainTokens: 4000 } }, custom: { tokenLimits: { triggerTokens: 10, contextTokens: 20 } } };
  assert.deepEqual(migrateRoutingPresetContextBudgets(raw), { default: { tokenLimits: { contextTokens: 200000, retainTokens: 4000 } }, custom: { tokenLimits: { contextTokens: 20 } } });
  assert.equal(raw.default.tokenLimits.triggerTokens, 200000);
});

test("完整请求超限触发摘要，系统和当前工具链不被删除，工具定义保持可用", async () => {
  const config = createLlmTestConfig();
  const tools = [createToolDefinition("read_file")];
  const messages = [
    { role: "system" as const, content: "角色设定" },
    { role: "system" as const, content: "旧摘要", contextHistorySummary: true },
    { role: "user" as const, content: "旧话题".repeat(500), contextHistoryTimestampMs: 1 },
    { role: "assistant" as const, content: "旧回答", contextHistoryTimestampMs: 2 },
    { role: "user" as const, content: "保留的近期话题", contextHistoryTimestampMs: 3 },
    { role: "user" as const, content: "当前要求" },
    { role: "assistant" as const, content: "", tool_calls: [{ id: "call", type: "function" as const, function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool" as const, content: "当前结果", tool_call_id: "call" }
  ];
  let calls = 0;
  const result = await prepareGenerationRequestBudget({ config, tools, messages, modelRef: "main", sessionId: "test", logger, transcript: [],
    budget: { contextTokens: 1200, inputTokens: 1000, outputTokens: 150, safetyTokens: 50 },
    compact: async () => { calls++; return { summary: "已完成旧任务；保留用户要求。", compressedTimestamps: [1, 2] }; }
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.slice(-4), messages.slice(-4));
  assert.equal(result[0], messages[0]);
  assert.ok(estimateRequestTokens(result, tools, config) < 1000);
  assert.equal(messages.length, 8);
});

test("每个候选重新预算，后续工具请求沿用压缩结果且不把内部历史标记发给服务端", async () => {
  const config = createLlmTestConfig([{ chat: { limits: { contextTokens: 6000 } } }, { chat: { limits: { contextTokens: 10000 } } }]);
  const seen: Array<[string, number]> = [];
  const call = { id: "call", type: "function", function: { name: "read", arguments: "{}" } };
  await withMockFetch([
    { assertRequest(body: any) { assert.equal(body.messages.length, 1); assert.equal(body.messages[0].contextHistoryTimestampMs, undefined); }, response: new Response("overloaded", { status: 503 }) },
    { assertRequest(body: any) { assert.equal(body.messages.length, 1); }, payloads: [{ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] }] },
    { assertRequest(body: any) { assert.equal(body.messages.length, 3); assert.ok(body.tools.some((tool: any) => tool.function.name === "read")); }, payloads: [{ choices: [{ delta: { content: "完成" } }] }] }
  ], async () => {
    const result = await new LlmClient(config, logger).generate({
      messages: [{ role: "user", content: "旧资料", contextHistoryTimestampMs: 1 }, { role: "user", content: "当前任务" }], tools: [createToolDefinition("read")],
      prepareRequestForBudget: async ({ messages, modelRef, budget }) => {
        seen.push([modelRef, budget.contextTokens]);
        return messages.filter(message => message.contextHistoryTimestampMs == null);
      }, toolExecutor: async () => "读取完成"
    });
    assert.equal(result.text, "完成");
  });
  assert.deepEqual(seen.slice(0, 2), [["main", 6000], ["candidate_2", 10000]]);
  assert.equal(seen.length, 3);
});

test("无法安全缩小的请求在调用服务前明确失败", async () => {
  const config = createLlmTestConfig({ chat: { limits: { contextTokens: 1000 } } });
  await withMockFetch([], async () => {
    await assert.rejects(new LlmClient(config, logger).generate({ messages: [{ role: "user", content: "大".repeat(1000) }] }), /估算输入.*可用输入/);
  });
});

test("摘要按自己的上下文拆分巨型单条历史，保留所有来源且逐块整合", async () => {
  const config = createLlmTestConfig({ chat: { limits: { contextTokens: 6000 } } });
  const source = "历史内容".repeat(6000);
  const sourceParts: string[] = [];
  let calls = 0;
  const summary = await generateHistorySummary({ config, prompt: { sessionId: "test", existingSummary: null, messagesToCompress: [{ role: "user", content: source, timestampMs: 1 }] },
    llmClient: { generate: async (params) => {
      assert.ok(estimateRequestTokens(params.messages, [], config) <= resolveModelRequestBudget(config.llm.models.main!, 150000).inputTokens);
      const content = String(params.messages[1]!.content);
      if (calls > 0) assert.match(content, /分块摘要/);
      sourceParts.push(...[...content.matchAll(/%%llmbot:summary_source_message[^\n]*\n([\s\S]*?)\n%%llmbot:\/summary_source_message/g)].map(match => match[1]!));
      calls++;
      return { text: "分块摘要" } as any;
    } }
  });
  assert.ok(calls > 1);
  assert.equal(sourceParts.join(""), source);
  assert.equal(summary, "分块摘要");
});

test("自动摘要原子提交：成功保留原记录，空摘要、膨胀摘要和取消均不覆盖历史", async () => {
  const { HistoryCompressor } = await import("#conversation/historyCompressor.ts");
  const { SessionManager } = await import("#conversation/session/sessionManager.ts");
  for (const outcome of ["success", "empty", "expanded", "aborted"] as const) {
    const config = createLlmTestConfig();
    config.conversation.historyCompression.enabled = true;
    config.llm.summarizer.enabled = true;
    const manager = new SessionManager(config);
    const id = `test:${outcome}`;
    manager.ensureSession({ id, type: "private" });
    manager.appendUserHistory(id, { chatType: "private", userId: "tester", senderName: "测试", text: "需要记住的历史内容".repeat(400) }, 1);
    manager.appendAssistantHistory(id, { chatType: "private", userId: "bot", senderName: "助手", text: "已完成旧任务" }, 2);
    manager.appendUserHistory(id, { chatType: "private", userId: "tester", senderName: "测试", text: "当前完整要求" }, 3);
    const before = structuredClone(manager.getSession(id).internalTranscript);
    const controller = new AbortController();
    const compressor = new HistoryCompressor(config, { isConfigured: () => true, generate: async () => {
      if (outcome === "aborted") controller.abort();
      return { text: outcome === "empty" ? " " : outcome === "expanded" ? "扩展内容".repeat(5000) : "记住用户要求，旧任务完成。" };
    } } as any, manager, { ensureReady: async () => new Map() } as any, logger);
    if (outcome === "empty" || outcome === "aborted") {
      await assert.rejects(compressor.compactForRequest(id, 100, controller.signal));
    } else {
      const result = await compressor.compactForRequest(id, 100, controller.signal);
      assert.equal(result != null, outcome === "success");
    }
    const after = manager.getSession(id);
    if (outcome === "success") {
      assert.equal(after.internalTranscript.length, before.length);
      assert.equal(after.internalTranscript[0]!.runtimeExclusionReason, "history_compressed");
      assert.notEqual(after.internalTranscript[2]!.runtimeExcluded, true);
      assert.equal(manager.getLlmVisibleHistory(id).length, 1);
    } else {
      assert.deepEqual(after.internalTranscript, before);
      assert.equal(after.historySummary, null);
    }
  }
});

test("固定输入已超限时不浪费摘要调用", async () => {
  const config = createLlmTestConfig();
  const messages = [{ role: "system" as const, content: "固定设定".repeat(500) }, { role: "user" as const, content: "历史", contextHistoryTimestampMs: 1 }];
  const result = await prepareGenerationRequestBudget({ config, messages, tools: [], modelRef: "main", sessionId: "test", transcript: [], logger,
    budget: { contextTokens: 1200, inputTokens: 1000, outputTokens: 150, safetyTokens: 50 },
    compact: async () => { assert.fail("不可压缩的固定输入不应触发付费摘要"); }
  });
  assert.deepEqual(result, messages);
});

import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { TurnPlanner } from "../../src/conversation/turnPlanner.ts";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import type { GenerationPromptBuilder } from "../../src/app/generation/generationPromptBuilder.ts";
import type { LlmClient, LlmMessage } from "../../src/llm/llmClient.ts";
import type { RunGenerationInput } from "../../src/app/generation/generationExecutor.ts";
import { collectReferencedImageIds } from "../../src/images/imagePromptContext.ts";
import { createConfiguredTestAppConfig } from "../helpers/character-fixtures.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createDefaultTurnPlan } from "../../src/conversation/turnPlanner/result.ts";
import type { InlineSessionTriggerExecution, SessionPhase } from "../../src/conversation/session/sessionTypes.ts";

type Entry = "chat" | "continuation" | "setup" | "scheduled" | "inline";
type PromptInput = {
  historyForPrompt: Array<{ role: "user" | "assistant"; content: string }>;
  replayMessages?: LlmMessage[];
  batchMessages?: Array<{ text: string }>;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function createHarness(options: {
  preserveThinking: boolean;
  entry: Entry;
  planner?: "success" | "disabled" | "failed";
  blockBuilder?: boolean;
  blockUserLookup?: boolean;
}) {
  const config = createConfiguredTestAppConfig({ llm: {
    enabled: true,
    turnPlanner: { enabled: options.planner !== "disabled", semanticWait: true },
    routingPresets: { test: { historyWindow: { maxRecentMessages: 80, maxImageReferences: 5 } } }
  } });
  config.llm.models.main!.chat!.preserveThinking = options.preserveThinking;
  config.llm.models.large = { ...config.llm.models.main!, model: "synthetic-large" };
  config.llm.routingPresets.test!.mainLarge = ["large"];
  const logger = pino({ level: "silent" });
  const sessionId = "web:request-context-orchestration";
  const sessionManager = new SessionManager(config);
  sessionManager.ensureSession({ id: sessionId, type: "private", source: "web" });
  sessionManager.setModeId(sessionId, options.entry === "setup" ? "stateful_rp" : "assistant");
  if (options.entry === "setup") {
    sessionManager.setOperationMode(sessionId, { kind: "persona_setup", draft: createEmptyPersona() });
  }
  for (let index = 0; index < 200; index++) {
    sessionManager.appendUserHistory(sessionId, {
      chatType: "private", userId: "owner", senderName: "合成用户",
      text: `历史消息 ${index}`, imageIds: [`history-image-${index}`]
    }, index + 1, { transcriptGroup: "standalone" });
  }
  const entered = deferred<{ input: PromptInput; phase: SessionPhase["kind"]; builder: string }>();
  const builderGate = deferred();
  const lookupEntered = deferred();
  const lookupGate = deferred();
  const done = deferred<RunGenerationInput>();
  let plannerCalls = 0;
  let failedModelCalls = 0;
  const llmClient = {
    isConfigured() { return true; },
    isCapabilityConfigured() { return false; },
    async generate() { failedModelCalls++; throw new Error("合成模型连接失败"); }
  } as unknown as LlmClient;
  const realFailedPlanner = new TurnPlanner(config, llmClient,
    { async getMany() { return []; } }, { async prepareFilesForModel() { return []; } }, logger);
  const turnPlanner = {
    isEnabled() { return options.planner !== "disabled"; },
    async decide(input: Parameters<TurnPlanner["decide"]>[0]) {
      plannerCalls++;
      if (options.planner === "failed") return realFailedPlanner.decide(input);
      return { ...createDefaultTurnPlan("合成规划通过"), modelTier: "small" as const, modelSelectionStatus: "decided" as const };
    }
  };
  const buildPrompt = (builder: string) => async (input: PromptInput) => {
    entered.resolve({ input, phase: sessionManager.getSession(sessionId).phase.kind, builder });
    if (options.blockBuilder) await builderGate.promise;
    return { promptMessages: [{ role: "system" as const, content: "合成请求" }], debugSnapshot: {} };
  };
  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config },
    sessionRuntime: {
      logger, sessionManager, llmClient, turnPlanner, sessionCaptioner: {}, debounceManager: {},
      historyCompressor: { getTopicCompressionCandidate() { return null; }, async compactForRequest() { return null; } }
    },
    identity: {
      userStore: { async getByUserId(userId: string) {
        if (options.blockUserLookup) { lookupEntered.resolve(); await lookupGate.promise; }
        return { userId, relationship: "owner" };
      } },
      personaStore: { async get() { return createEmptyPersona(); } }, setupStore: {}, scenarioHostStateStore: {},
      globalProfileReadinessStore: { async get() { return { persona: "ready", rp: "ready", updatedAt: 1 }; } }
    },
    toolRuntime: { shellRuntime: { isInputPromptCurrent() { return true; } } },
    lifecycle: { persistSession() {}, getScheduler() { return {}; } }
  } as any, {
    promptBuilder: {
      buildChatPromptMessages: buildPrompt("chat"), buildSetupPromptMessages: buildPrompt("setup"),
      buildScheduledPromptMessages: buildPrompt("scheduled")
    } as unknown as GenerationPromptBuilder,
    async runGeneration(input) { done.resolve(input); }, processNextSessionWork() {}
  });
  const trigger = { targetType: "private" as const, targetUserId: "owner", targetSenderName: "合成用户",
    jobName: "合成后台任务", instruction: "继续处理选中的上下文", enqueuedAt: 1000 };
  return {
    sessionId, sessionManager, entered, builderGate, lookupEntered, lookupGate, done,
    get plannerCalls() { return plannerCalls; }, get failedModelCalls() { return failedModelCalls; },
    start(): Promise<void> | void {
      if (options.entry === "scheduled") return orchestrator.runInternalTriggerSession(sessionId, { ...trigger, kind: "scheduled_instruction" });
      if (options.entry === "inline") {
        const event: InlineSessionTriggerExecution = { ...trigger, kind: "download_failed", resourceId: "synthetic-download",
          sourceUrl: "https://example.invalid/synthetic", error: "合成失败事件" };
        return orchestrator.runInlineTriggerBatchSession(sessionId, [event]);
      }
      sessionManager.appendPendingMessage(sessionId, {
        channelId: "web", externalUserId: "owner", chatType: "private", userId: "owner", senderName: "合成用户",
        text: "当前输入只出现一次", images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [],
        forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false
      });
      orchestrator.flushSession(sessionId, { skipReplyGate: options.entry === "continuation" });
    }
  };
}

for (const entry of ["chat", "continuation", "setup", "scheduled", "inline"] as const) {
  for (const preserveThinking of [false, true]) {
    test(`${entry} sends the shared 80-message / 5-image view to prompt preparation (native=${preserveThinking})`, { timeout: 10000 }, async () => {
      const h = createHarness({ entry, preserveThinking, blockBuilder: true });
      const running = h.start();
      const captured = await h.entered.promise;
      try {
        assert.equal(captured.phase, "preparing_context");
        assert.equal(h.sessionManager.isGenerating(h.sessionId), true, "media preparation remains an active generation");
        const history = captured.input.historyForPrompt;
        const replay = (captured.input.replayMessages ?? []).filter((message): message is LlmMessage & { content: string } => typeof message.content === "string");
        const actual = preserveThinking ? replay : history;
        assert.equal(actual.length, 80);
        assert.match(actual[0]!.content, /历史消息 120\b/);
        assert.match(actual.at(-1)!.content, /历史消息 199\b/);
        assert.deepEqual(collectReferencedImageIds(actual), [195, 196, 197, 198, 199].map(index => `history-image-${index}`));
        assert.equal(preserveThinking ? history.length : replay.length, 0, "history is represented exactly once");
        assert.equal(actual.some(message => message.content.includes("当前输入只出现一次")), false, "current group is excluded from history replay");
        if (entry === "chat" || entry === "continuation" || entry === "setup") {
          assert.equal(captured.input.batchMessages?.filter(message => message.text === "当前输入只出现一次").length, 1);
        }
        if (entry === "setup") assert.equal(captured.builder, "setup");
        const preservedHistory = h.sessionManager.getSession(h.sessionId).internalTranscript.filter(item => item.kind === "user_message" && item.text.startsWith("历史消息 "));
        assert.equal(preservedHistory.length, 200, "request clipping must not delete stored history");
        assert.equal(preservedHistory.some(item => item.runtimeExcluded), false);
      } finally { h.builderGate.resolve(); }
      await h.done.promise;
      await running;
    });
  }
}

for (const planner of ["disabled", "failed"] as const) {
  test(`planner ${planner} enters preparing_context before the pending media stage`, { timeout: 10000 }, async () => {
    const h = createHarness({ entry: "chat", preserveThinking: true, planner, blockBuilder: true });
    h.start();
    const captured = await h.entered.promise;
    try {
      assert.equal(captured.phase, "preparing_context");
      assert.equal(h.plannerCalls, planner === "disabled" ? 0 : 1);
      if (planner === "failed") {
        assert.equal(h.failedModelCalls, 1, "exercise real TurnPlanner fallback after a model connection failure");
        const decisions = h.sessionManager.getSession(h.sessionId).internalTranscript.filter(item => item.kind === "gate_decision");
        assert.match(decisions.at(-1)?.reason ?? "", /规划失败/);
      }
    } finally { h.builderGate.resolve(); }
    await h.done.promise;
  });
}

test("a late preparation callback cannot overwrite a newer mutation epoch phase", { timeout: 10000 }, async () => {
  const h = createHarness({ entry: "continuation", preserveThinking: true, planner: "disabled", blockUserLookup: true });
  h.start();
  await h.lookupEntered.promise;
  const oldEpoch = h.sessionManager.getMutationEpoch(h.sessionId);
  h.sessionManager.getSession(h.sessionId).mutationEpoch += 1;
  assert.equal(h.sessionManager.setSessionPhaseIfEpochMatches(h.sessionId, oldEpoch + 1, { kind: "generating" }), true);
  h.lookupGate.resolve();
  const captured = await h.entered.promise;
  assert.equal(captured.phase, "generating");
  await h.done.promise;
  assert.equal(h.sessionManager.getSession(h.sessionId).phase.kind, "generating");
});

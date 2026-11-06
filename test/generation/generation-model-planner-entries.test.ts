import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import { createConfiguredTestAppConfig } from "../helpers/character-fixtures.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import type { TurnPlannerInput } from "../../src/conversation/turnPlanner/types.ts";
import type { InternalSessionTriggerExecution, InlineSessionTriggerExecution } from "../../src/conversation/session/sessionTypes.ts";
import type { RunGenerationInput } from "../../src/app/generation/generationExecutor.ts";

function harness() {
  const config = createConfiguredTestAppConfig({ llm: { enabled: true, turnPlanner: { enabled: true } } });
  config.llm.models.large = { ...config.llm.models.main!, model: "large-entry" };
  config.llm.routingPresets.test!.mainLarge = ["large"];
  const sessionId = "web:model-entry";
  const sessionManager = new SessionManager(config);
  sessionManager.ensureSession({ id: sessionId, type: "private", source: "web" });
  sessionManager.setModeId(sessionId, "assistant");
  sessionManager.getSession(sessionId).historySummary = "原任务需要比较多套约束并检查方案一致性，尚未完成。";
  sessionManager.setTaskTracker(sessionId, { version: 1, primary: { taskId: "original", status: "active", objective: "综合三份材料并解决相互矛盾的约束", done: [], next: ["形成综合结论"], blockers: [], importantToolRefs: [], createdAtMs: 1, updatedAtMs: 1 }, parked: [] });
  const plannerInputs: TurnPlannerInput[] = [];
  const runs: RunGenerationInput[] = [];
  let resolve!: () => void;
  const done = new Promise<void>(complete => { resolve = complete; });
  const buildPrompt = async () => ({ promptMessages: [{ role: "system", content: "测试入口" }], debugSnapshot: {} });
  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config }, sessionRuntime: { logger: pino({ level: "silent" }), sessionManager,
      llmClient: { isConfigured() { return true; } }, sessionCaptioner: {}, debounceManager: {},
      historyCompressor: { getTopicCompressionCandidate() { throw new Error("model-only must not plan topic compression"); } },
      turnPlanner: { isEnabled() { return true; }, async decide(input: TurnPlannerInput) {
        plannerInputs.push(input);
        return { replyDecision: "reply", modelTier: "large", modelSelectionStatus: "decided", taskBasis: "任务涉及多材料综合与约束一致性判断。", reason: "使用完整模型", topicDecision: "continue_topic", requiredCapabilities: [], contextDependencies: [], recentDomainReuse: [], followupMode: "none", toolsetIds: [] };
      } }
    }, identity: { userStore: { async getByUserId(userId: string) { return { userId, relationship: "owner" }; } },
      personaStore: { async get() { return createEmptyPersona(); } }, setupStore: {}, scenarioHostStateStore: {},
      globalProfileReadinessStore: { async get() { return { persona: "ready", rp: "ready", updatedAt: 1 }; } }
    }, toolRuntime: { shellRuntime: { isInputPromptCurrent() { return true; } } }, lifecycle: { persistSession() {}, getScheduler() { return {}; } }
  } as any, { promptBuilder: { buildChatPromptMessages: buildPrompt, buildSetupPromptMessages: buildPrompt, buildScheduledPromptMessages: buildPrompt } as any,
    async runGeneration(input) { runs.push(input); resolve(); }, processNextSessionWork() {} });
  return { config, sessionId, sessionManager, plannerInputs, runs, done, orchestrator };
}
function pendingMessage(h: ReturnType<typeof harness>) {
  h.sessionManager.appendPendingMessage(h.sessionId, { channelId: "web", externalUserId: "owner", chatType: "private", userId: "owner", senderName: "Owner", text: "继续整理", images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [], forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false });
}
const trigger = { targetType: "private" as const, targetUserId: "owner", targetSenderName: "Owner", jobName: "综合任务", instruction: "基于已取得的材料继续综合并检查约束。", enqueuedAt: 1 };
function assertModelOnly(h: ReturnType<typeof harness>) {
  assert.equal(h.plannerInputs.length, 1);
  const plannerInput = h.plannerInputs[0]!;
  assert.deepEqual(plannerInput.requirements, { modelSelection: true, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: false, toolSelection: false, skillSelection: false });
  assert.match(plannerInput.taskSummary!, /多套约束/);
  assert.match(plannerInput.taskContext!.primary!.objective, /相互矛盾的约束/);
  assert.deepEqual(h.runs[0]!.resolvedModelRef, ["large"]);
  const records = h.sessionManager.getSession(h.sessionId).internalTranscript.filter(item => item.kind === "gate_decision");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.taskBasis, "任务涉及多材料综合与约束一致性判断。");
}

for (const setup of [false, true]) test(`explicit continuation/setup generation uses model-only planner: ${setup}`, async () => {
  const h = harness();
  if (setup) h.sessionManager.setOperationMode(h.sessionId, { kind: "persona_setup", draft: createEmptyPersona() });
  pendingMessage(h);
  h.orchestrator.flushSession(h.sessionId, { skipReplyGate: !setup });
  await h.done;
  assertModelOnly(h);
});

test("scheduled text-only task uses model-only planning before main generation", async () => {
  const h = harness();
  await h.orchestrator.runInternalTriggerSession(h.sessionId, { ...trigger, kind: "scheduled_instruction" } satisfies InternalSessionTriggerExecution);
  assertModelOnly(h);
  assert.match(h.plannerInputs[0]!.batchMessages[0]!.text, /基于已取得的材料/);
});

test("batched background callbacks plan once with every event and original task context", async () => {
  const h = harness();
  const event: InlineSessionTriggerExecution = { ...trigger, kind: "download_failed", resourceId: "download-1", sourceUrl: "https://example.com/source", error: "测试失败" };
  await h.orchestrator.runInlineTriggerBatchSession(h.sessionId, [event, { ...event, resourceId: "download-2", instruction: "第二份材料已就绪，继续对照分析。" }]);
  assertModelOnly(h);
  assert.equal(h.plannerInputs[0]!.batchMessages.length, 2);
  assert.match(h.plannerInputs[0]!.batchMessages[1]!.text, /第二份材料/);
});

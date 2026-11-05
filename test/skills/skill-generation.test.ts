import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { rmSync } from "node:fs";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import { handleGenerationTurnPlanner } from "../../src/app/generation/generationTurnPlanner.ts";
import type { RunGenerationInput } from "../../src/app/generation/generationExecutor.ts";
import type { GenerationSessionOrchestratorDeps, GenerationTurnPlannerDeps } from "../../src/app/generation/generationRunnerDeps.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import type { SessionOperationMode } from "../../src/conversation/session/sessionOperationMode.ts";
import type { InlineSessionTriggerExecution } from "../../src/conversation/session/sessionTypes.ts";
import { createInitialScenarioHostSessionState } from "../../src/modes/scenarioHost/types.ts";
import { SKILL_TOOL_NAMES, SKILL_MAINTENANCE_TOOL_NAMES } from "../../src/skills/skillPolicy.ts";
import { getSkillStore } from "../../src/skills/skillStore.ts";
import { startSkillDraft } from "../../src/skills/skillDrafts.ts";
import { createConfiguredTestAppConfig } from "../helpers/character-fixtures.ts";
import {
  createGenerationReplyGateDeps, createGenerationReplyGateHandlers, createGenerationReplyGateInput
} from "../helpers/reply-gate-fixtures.tsx";

type PromptCapture = { visibleToolNames?: string[]; phase?: string };

function createOrchestratorHarness(t: TestContext, options: {
  modeId?: string;
  operationMode?: SessionOperationMode;
  maintenanceEnabled?: boolean;
} = {}) {
  const config = createConfiguredTestAppConfig({
    llm: { enabled: true },
    skills: { modelMaintenanceEnabled: options.maintenanceEnabled ?? true },
    conversation: { crossConversation: { enabled: false } }
  });
  t.after(() => rmSync(config.dataDir, { recursive: true, force: true }));
  const sessionManager = new SessionManager(config);
  const sessionId = "web:skill-generation";
  sessionManager.ensureSession({ id: sessionId, type: "private", source: "web" });
  sessionManager.setModeId(sessionId, options.modeId ?? "assistant", { appendSwitchMarker: false });
  if (options.operationMode?.kind === "skill_config") startSkillDraft(config, sessionId, options.operationMode.skillId);
  if (options.operationMode) sessionManager.setOperationMode(sessionId, options.operationMode);
  const scenarioState = createInitialScenarioHostSessionState({ playerUserId: "owner", playerDisplayName: "Owner" });
  const captures: PromptCapture[] = [];
  let resolveRun!: (input: RunGenerationInput) => void;
  let rejectRun!: (error: unknown) => void;
  const run = new Promise<RunGenerationInput>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
  const logger = pino({ level: "silent" });
  // 异步 flush 的准备错误应直接使测试失败，避免仅等待未到达的 executor。
  logger.error = ((fields: { err?: unknown }) => rejectRun(fields.err ?? new Error("编排准备失败"))) as typeof logger.error;
  const capturePrompt = async (input: PromptCapture) => {
    captures.push(input);
    return { promptMessages: [{ role: "system", content: "测试提示" }], debugSnapshot: {} };
  };
  const deps = {
    promptBuilder: { config },
    sessionRuntime: {
      logger, sessionManager,
      llmClient: { isConfigured: () => true },
      turnPlanner: { isEnabled: () => false },
      historyCompressor: { getTopicCompressionCandidate: () => null },
      sessionCaptioner: {}, debounceManager: {}
    },
    identity: {
      userStore: { async getByUserId(userId: string) { return { userId, relationship: "owner" }; } },
      personaStore: {},
      scenarioHostStateStore: { async ensureForSession() { return scenarioState; } },
      globalProfileReadinessStore: { async get() { return { persona: "ready", rp: "ready", updatedAt: 1 }; } },
      conversationAccess: {}
    },
    toolRuntime: { shellRuntime: { isInputPromptCurrent: () => true } },
    lifecycle: { persistSession() {}, getScheduler() { return {}; } }
  } as unknown as GenerationSessionOrchestratorDeps;
  const orchestrator = createGenerationSessionOrchestrator(deps, {
    promptBuilder: {
      buildChatPromptMessages: capturePrompt,
      buildSetupPromptMessages: capturePrompt,
      buildScheduledPromptMessages: capturePrompt
    } as unknown as Parameters<typeof createGenerationSessionOrchestrator>[1]["promptBuilder"],
    async runGeneration(input) { resolveRun(input); },
    processNextSessionWork() {}
  });
  const trigger: InlineSessionTriggerExecution = {
    kind: "download_failed", targetType: "private", targetUserId: "owner", targetSenderName: "Owner",
    jobName: "测试后台下载", instruction: "说明下载结果", enqueuedAt: 1,
    resourceId: "test-download", sourceUrl: "https://example.com/test", error: "测试失败"
  };
  async function start(entry: "flush" | "internal" | "inline") {
    if (entry === "flush") {
      sessionManager.appendPendingMessage(sessionId, {
        chatType: "private", userId: "owner", senderName: "Owner", text: "编辑技能",
        images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [],
        forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false
      });
      orchestrator.flushSession(sessionId, { skipReplyGate: true });
    } else if (entry === "internal") await orchestrator.runInternalTriggerSession(sessionId, trigger);
    else await orchestrator.runInlineTriggerBatchSession(sessionId, [trigger]);
    return run;
  }
  return { config, sessionId, sessionManager, captures, start };
}

for (const entry of ["flush", "internal", "inline"] as const) {
  test(`${entry} 编排预计算工具清单包含技能入口并尊重维护开关`, { timeout: 5000 }, async t => {
    const f = createOrchestratorHarness(t, { maintenanceEnabled: false });
    await f.start(entry);
    const visible = f.captures[0]!.visibleToolNames!;
    assert.ok(["list_skills", "load_skill", "read_skill_resource"].every(name => visible.includes(name)));
    assert.ok(SKILL_MAINTENANCE_TOOL_NAMES.every(name => !visible.includes(name)));
  });
  test(`${entry} 编排透传技能草稿操作，关闭自主维护仍可编辑草稿`, { timeout: 5000 }, async t => {
    const f = createOrchestratorHarness(t, {
      maintenanceEnabled: false, operationMode: { kind: "skill_config", skillId: "test-guide" }
    });
    const generation = await f.start(entry);
    assert.ok(SKILL_TOOL_NAMES.every(name => f.captures[0]!.visibleToolNames!.includes(name)));
    assert.notEqual(generation.setupMode, true);
  });
}

for (const kind of ["normal", "skill_config"] as const) {
  test(`未初始化 scenario_host 的 ${kind} 流程正确区分自动 setup 与技能配置`, { timeout: 5000 }, async t => {
    const f = createOrchestratorHarness(t, {
      modeId: "scenario_host",
      operationMode: kind === "normal" ? { kind } : { kind, skillId: "test-guide" }
    });
    const generation = await f.start("flush");
    const hasSkills = f.captures[0]!.visibleToolNames!.some(name => SKILL_TOOL_NAMES.includes(name));
    assert.equal(hasSkills, kind === "skill_config");
    assert.equal(generation.setupMode === true, kind === "normal");
    assert.equal(f.sessionManager.getOperationMode(f.sessionId).kind, kind);
  });
}

const plannerCases: Array<{
  name: string; modeId: string; operationMode: SessionOperationMode; setupMode?: boolean; skillsAllowed: boolean;
}> = [
  { name: "普通助手", modeId: "assistant", operationMode: { kind: "normal" }, skillsAllowed: true },
  { name: "人设编辑", modeId: "assistant", operationMode: { kind: "persona_config", draft: {} as never }, skillsAllowed: false },
  { name: "角色编辑", modeId: "stateful_rp", operationMode: { kind: "character_config", stage: "persona" }, skillsAllowed: false },
  { name: "自动初始化", modeId: "scenario_host", operationMode: { kind: "normal" }, setupMode: true, skillsAllowed: false },
  { name: "有状态角色普通轮次", modeId: "stateful_rp", operationMode: { kind: "normal" }, skillsAllowed: false },
  { name: "有状态角色技能草稿", modeId: "stateful_rp", operationMode: { kind: "skill_config", skillId: "test-guide" }, skillsAllowed: true }
];
for (const value of plannerCases) {
  test(`Planner 在${value.name}中按统一准入规则提供技能候选`, async t => {
    const config = createConfiguredTestAppConfig({
      llm: { enabled: true, turnPlanner: { toolSelection: "planned" } }, skills: { plannerSelectionEnabled: true }
    });
    t.after(() => rmSync(config.dataDir, { recursive: true, force: true }));
    getSkillStore(config).write("test-guide", {
      expectedRevision: null, document: "---\nname: test-guide\ndescription: 测试规划器技能候选。\n---\n先确认需求再实施操作。",
      resources: {}, toolsetIds: [], userPolicy: "auto", modelEditable: true, modelPaused: false
    }, "user");
    let selected: string[] | undefined;
    const turnPlanner = {
      isEnabled: () => true,
      async decide(input: { availableSkills: Array<{ id: string }> }) {
        selected = input.availableSkills.map(skill => skill.id);
        return {
          replyDecision: "reply_small", topicDecision: "continue_topic", reason: "验证候选", toolsetIds: ["time_utils"],
          requiredCapabilities: [], contextDependencies: [], recentDomainReuse: [], followupMode: "none"
        };
      }
    } as unknown as GenerationTurnPlannerDeps["turnPlanner"];
    const base = createGenerationReplyGateInput();
    const result = await handleGenerationTurnPlanner(
      createGenerationReplyGateDeps({ config, turnPlanner }), createGenerationReplyGateHandlers(),
      createGenerationReplyGateInput({
        modeId: value.modeId, operationMode: value.operationMode,
        ...(value.setupMode !== undefined ? { setupMode: value.setupMode } : {}),
        batchMessages: [{ ...base.batchMessages[0]!, text: "现在几点", audioSources: [] }],
        availableToolsets: [{ id: "time_utils", title: "时间", description: "查询时间", toolNames: ["get_current_time"] }]
      })
    );
    assert.equal(result.action, "continue");
    assert.ok(selected);
    assert.equal(selected.includes("test-guide"), value.skillsAllowed);
  });
}

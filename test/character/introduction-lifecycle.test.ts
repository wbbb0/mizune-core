import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { persistedSessionStateSchema } from "../../src/conversation/session/sessionPersistence.ts";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import type { RunGenerationInput } from "../../src/app/generation/generationExecutor.ts";
import { dispatchChatDirectCommand } from "../../src/app/messaging/messageCommandFlow.ts";
import { enqueueCharacterIntroduction } from "../../src/character/introduction.ts";
import { characterRepository } from "../../src/character/repository.ts";
import { characterStages, type CharacterStage } from "../../src/character/model.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createDirectCommandFixture } from "../helpers/direct-command-fixtures.tsx";
import type { SessionDelivery } from "../../src/conversation/session/sessionTypes.ts";
import type { ToolActorAuthorization } from "../../src/services/messaging/toolActorAuthorization.ts";

const logger = pino({ level: "silent" });
function fixture(stage: CharacterStage = "social", source: SessionDelivery = "qq_official") {
  const config = createTestAppConfig({ llm: { enabled: true } });
  const sessionId = source === "web" ? "web:introduction" : source === "onebot" ? "qqbot:p:external-owner" : "qq_official.test:p:external-owner";
  const manager = new SessionManager(config);
  manager.ensureSession({ id: sessionId, type: "private", source, participantRef: { kind: "user", id: "owner" } });
  manager.setModeId(sessionId, "stateful_rp");
  const store = characterRepository(config.dataDir);
  const draft = store.begin(sessionId, stage, "config", "stateful_rp");
  manager.setOperationMode(sessionId, { kind: "character_config", stage });
  const actor: ToolActorAuthorization = source === "web" ? { kind: "web", internalUserId: "owner" }
    : { kind: "external", channelId: source === "onebot" ? "qqbot" : "qq_official.test", externalId: "external-owner", scope: "private_user", internalUserId: "owner" };
  const permit = { platform: "qq_official" as const, connectionId: "qq_official.test", chatType: "private" as const, targetId: "external-owner", messageId: "command-1", receivedAtMs: Date.now(), expiresAtMs: Date.now() + 300000, maxMessages: 5 };
  let flushes = 0;
  const queue = () => enqueueCharacterIntroduction({ dataDir: config.dataDir, sessionId, userId: "owner", actorAuthorization: actor,
    ...(source === "qq_official" ? { replyContext: permit } : {}), sessionManager: manager, persist() {}, flushSession() { flushes++; } });
  const runs: RunGenerationInput[] = [];
  const directives: string[] = [];
  const prompt = async (input: { currentTurnDirectives?: string[] }) => {
    directives.push(...input.currentTurnDirectives ?? []);
    return { promptMessages: [{ role: "system", content: "配置引导测试" }], debugSnapshot: {} };
  };
  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config },
    sessionRuntime: { logger, sessionManager: manager, llmClient: { isConfigured: () => true },
      turnPlanner: { isEnabled: () => false }, historyCompressor: {}, sessionCaptioner: {}, debounceManager: {} },
    identity: { userStore: { async getByUserId() { return { userId: "owner", relationship: "owner" }; } },
      globalProfileReadinessStore: { async get() { return { persona: "ready", rp: "ready" }; } },
      statefulRpStateStore: { async get() { return null; } }, scenarioHostStateStore: {}, personaStore: {}, setupStore: {} },
    toolRuntime: {}, lifecycle: { persistSession() {} }
  } as never, {
    promptBuilder: { buildChatPromptMessages: prompt, buildSetupPromptMessages: prompt } as never,
    async runGeneration(input) { runs.push(input); }, processNextSessionWork() {}
  });
  const waitForRun = async () => {
    const deadline = Date.now() + 2000;
    while (!runs.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runs.length, 1, "必须实际到达 generation，不能只验证入队计数");
    return runs[0]!;
  };
  return { config, manager, store, draft, sessionId, actor, permit, queue, runs, directives, orchestrator, waitForRun, flushes: () => flushes };
}

for (const source of ["onebot", "qq_official", "web"] as const) {
  for (const stage of characterStages) test(`${source} ${stage} 无追加消息即可携带真实身份与发送授权进入引导生成`, async () => {
    const f = fixture(stage, source);
    f.queue(); f.queue();
    assert.equal(f.flushes(), 1);
    const message = f.manager.getSession(f.sessionId).pendingMessages[0]!;
    assert.deepEqual(message.actorAuthorization, f.actor);
    assert.deepEqual(message.intent, { kind: "character_introduction", draftId: f.draft.id });
    assert.equal(message.text, "");
    assert.equal(f.store.draft(f.sessionId)!.introduction, "pending");
    f.orchestrator.flushSession(f.sessionId, { delivery: source, skipReplyGate: true });
    const run = await f.waitForRun();
    assert.deepEqual(run.sendTarget.actorAuthorization, f.actor);
    assert.equal(run.characterIntroductionDraftId, f.draft.id);
    assert.deepEqual(run.sendTarget.replyContext, source === "qq_official" ? f.permit : undefined);
    assert.match(f.directives.join("\n"), new RegExp(`配置 ${stage} 阶段`));
    assert.equal(f.store.draft(f.sessionId)!.introduction, "pending");
    f.queue();
    assert.equal(f.flushes(), 1, "当前回复期间不重复启动引导");
    f.manager.interruptResponse(f.sessionId);
    f.queue();
    assert.equal(f.flushes(), 2, "失败或取消未投递的引导仍可再次调度");
  });
}

test("取消并重建草稿后，旧引导事件不启动模型，也不认领新草稿", () => {
  const f = fixture();
  f.queue();
  f.store.cancel(f.sessionId);
  const next = f.store.begin(f.sessionId, "social", "config", "stateful_rp");
  f.orchestrator.flushSession(f.sessionId, { delivery: "qq_official" });
  assert.equal(f.runs.length, 0);
  assert.equal(f.manager.getSession(f.sessionId).pendingMessages.length, 0);
  assert.equal(f.store.draft(f.sessionId)!.id, next.id);
  assert.equal(f.store.draft(f.sessionId)!.introduction, "pending");
});

test("恢复保留身份与引导事件，不复用 QQ 临时回复授权；新消息可继续待引导草稿", async () => {
  const f = fixture(); f.queue();
  const saved = f.manager.getPersistedSession(f.sessionId);
  const validated = persistedSessionStateSchema.parse(saved);
  assert.deepEqual(validated.pendingMessages[0]!.actorAuthorization, f.actor);
  assert.deepEqual(saved.pendingMessages[0]!.intent, { kind: "character_introduction", draftId: f.draft.id });
  assert.equal("replyContext" in saved.pendingMessages[0]!, false);
  f.manager.restorePersistedSession(saved);
  f.orchestrator.flushSession(f.sessionId, { delivery: "qq_official" });
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.draft(f.sessionId)!.introduction, "pending");
  f.manager.appendSyntheticPendingMessage(f.sessionId, { chatType: "private", userId: "owner", senderName: "测试用户", text: "继续配置", images: [], actorAuthorization: f.actor, replyContext: f.permit });
  f.orchestrator.flushSession(f.sessionId, { delivery: "qq_official" });
  assert.deepEqual((await f.waitForRun()).sendTarget.actorAuthorization, f.actor);
  assert.match(f.directives.join("\n"), /配置 social 阶段/);
});

test("真实命令分发传递入口授权，配置确认回复先于引导调度", async () => {
  const f = fixture();
  let received: unknown;
  await dispatchChatDirectCommand(logger, f.manager, () => {}, async input => { received = input.incomingMessage; }, {
    session: f.manager.getSession(f.sessionId), user: { relationship: "owner" },
    enrichedMessage: { chatType: "private", userId: "owner", text: ".config social", actorAuthorization: f.actor, replyContext: f.permit } as never
  }, { name: "config", target: "social" });
  assert.deepEqual((received as { actorAuthorization: unknown }).actorAuthorization, f.actor);
  assert.deepEqual((received as { replyContext: unknown }).replyContext, f.permit);
  const order: string[] = [];
  const command = createDirectCommandFixture({ session: { modeId: "stateful_rp" },
    appendSyntheticPendingMessage(_id, message) { order.push("queued"); assert.deepEqual(message.actorAuthorization, f.actor); assert.deepEqual(message.replyContext, f.permit); },
    flushSession() { order.push("flushed"); },
    persistSession(_id, reason) { order.push(reason); }
  });
  await command.handler({ command: { name: "config", target: "social" }, sessionId: "qqbot:p:owner",
    incomingMessage: { chatType: "private", userId: "owner", relationship: "owner", actorAuthorization: f.actor, replyContext: f.permit } });
  assert.equal(command.calls.length, 1);
  assert.deepEqual(order.slice(-3), ["queued", "character_introduction_enqueued", "flushed"]);
});

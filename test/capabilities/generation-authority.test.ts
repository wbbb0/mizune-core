import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createGenerationExecutor } from "../../src/app/generation/generationExecutor.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { withMediaServices } from "../helpers/media-import-fixtures.ts";
import { createMessageProcessingContext } from "../../src/app/messaging/messageContextBuilder.ts";

// Deliberately drive the real generation assembly with an in-memory provider.
// No network, formal configuration or persisted conversation data is involved.
async function runBoundary(options: {
  source: "onebot" | "qq_official";
  tool: string;
  initiallyEnabled?: boolean;
  missingActor?: boolean;
  useAuthenticatedBuilder?: boolean;
  afterDisplay: (state: { config: ReturnType<typeof createTestAppConfig>; sessions: SessionManager; sessionId: string; revoke: () => void }) => void;
}) {
  const config = createTestAppConfig({ llm: { enabled: true }, shell: { enabled: options.initiallyEnabled ?? true }, qqOfficial: { enabled: true, appId: "test-app" } });
  config.configRuntime.instanceName = "qqbot";
  const logger = pino({ level: "silent" });
  const sessions = new SessionManager(config);
  const sessionId = options.source === "qq_official" ? "qq_official.test-app:p:external-owner" : "qqbot:p:owner";
  sessions.ensureSession({ id: sessionId, type: "private", source: options.source });
  const started = sessions.beginSyntheticGeneration(sessionId);
  let bound = true;
  let handlerCalls = 0;
  let displayNames: string[] = [];
  let outcome = "";
  let providerCalls = 0;
  const owner = { userId: "owner", relationship: "owner", specialRole: null };
  const userStore = { async getByUserId(id: string) { return id === "owner" ? owner : null; } };
  const userIdentityStore = {
    async ensureUserIdentity(query: { channelId: string; externalId: string; scope: string }) {
      assert.deepEqual(query, { channelId: "qq_official.test-app", externalId: "external-owner", scope: "private_user" });
      return { internalUserId: "owner" };
    },
    async findInternalUserId(query: { channelId: string; externalId: string; scope: string }) {
      assert.deepEqual(query, options.source === "qq_official"
        ? { channelId: "qq_official.test-app", externalId: "external-owner", scope: "private_user" }
        : { channelId: "qqbot", externalId: "owner", scope: "private_user" });
      return bound ? "owner" : null;
    },
    async findIdentityByInternalUserId() { return bound ? { externalUserId: "external-owner", userId: "owner" } : null; }
  };
  let actorAuthorization: unknown = options.source === "qq_official"
    ? { kind: "external", internalUserId: "owner", channelId: "qq_official.test-app", externalId: "external-owner", scope: "private_user" }
    : { kind: "external", internalUserId: "owner", channelId: "qqbot", externalId: "owner", scope: "private_user" };
  if (options.useAuthenticatedBuilder) {
    const incoming = { source: "qq_official", channelId: "qq_official.test-app", externalUserId: "external-owner", userId: "external-owner", chatType: "private", senderName: "测试", text: "测试", images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [], attachments: [], forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false };
    const context = await createMessageProcessingContext(withMediaServices({
      sessionManager: sessions, userIdentityStore, userStore: { ...userStore, async touchSeenUser({ userId }: { userId: string }) { assert.equal(userId, "owner"); return owner; } },
      audioStore: { async registerSources() { return []; } }, chatFileStore: {}, setupStore: { async get() { return {}; } }
    }) as any, incoming as any, { delivery: "web", targetSessionId: sessionId });
    assert.equal(context.enrichedMessage.userId, "owner");
    sessions.appendPendingMessage(sessionId, context.enrichedMessage);
    actorAuthorization = sessions.getSession(sessionId).pendingMessages.at(-1)?.actorAuthorization;
    assert.deepEqual(actorAuthorization, { kind: "external", internalUserId: "owner", channelId: "qq_official.test-app", externalId: "external-owner", scope: "private_user" });
  }
  const executor = (createGenerationExecutor as any)({
    promptBuilder: { config, mediaVisionService: {}, mediaCaptionService: {} },
    sessionRuntime: {
      logger, sessionManager: sessions,
      llmClient: { isConfigured: () => true, async generate(input: any) {
        providerCalls++;
        displayNames = (typeof input.tools === "function" ? input.tools() : input.tools ?? []).map((tool: any) => tool.function.name);
        options.afterDisplay({ config, sessions, sessionId, revoke: () => { bound = false; } });
        const call = { id: "boundary-call", type: "function", function: { name: options.tool, arguments: "{}" } };
        const result = await input.toolExecutor(call);
        outcome = typeof result === "string" ? result : result.content;
        return { text: "", reasoningContent: "", finishReason: { kind: "completed" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: null, reasoningTokens: 0, providerReported: false, requestCount: 1, modelRef: "main", model: "fake" } };
      } },
      turnPlanner: {}, debounceManager: {}, historyCompressor: { async compactForRequest() { return null; } },
      sessionCaptioner: { isAvailable: () => false }, messageQueue: { getDrainPromise: () => Promise.resolve() }
    },
    toolRuntime: withMediaServices({
      oneBotClient: {}, audioStore: {}, requestStore: {}, scheduledJobStore: {},
      shellRuntime: { async listSessionResources() { handlerCalls++; return []; } },
      searchService: {}, browserService: {}, downloadRuntime: { read: () => null }, localFileService: {}, chatFileStore: {}, comfyClient: {}, comfyTaskStore: {}, comfyTemplateCatalog: {}
    }),
    identity: { userStore, userIdentityStore, whitelistStore: {}, personaStore: {}, globalRuleStore: {}, toolsetRuleStore: {}, scenarioHostStateStore: {}, setupStore: { async isReady() { return false; } }, conversationAccess: {}, npcDirectory: {} },
    lifecycle: { logger, sessionManager: sessions, userStore, userIdentityStore, persistSession() {}, getScheduler: () => ({}) }
  }, { processNextSessionWork() {} }, { waitForAbortGraceWindow: async () => {} });
  await executor.runGeneration({
    sessionId, expectedEpoch: sessions.getSession(sessionId).mutationEpoch,
    responseAbortController: started.responseAbortController, responseEpoch: started.responseEpoch, abortController: started.abortController,
    modeId: "assistant", relationship: "owner", interactionMode: "normal", internalTranscript: [], debugMarkers: [], currentUser: owner,
    persona: { name: "测试助手", temperament: "冷静", voiceStyle: "简洁" },
    batchMessages: [{ chatType: "private", userId: "owner", senderName: "测试", text: "测试", images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [], attachments: [], forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false, receivedAt: 1 }],
    sendTarget: { delivery: "web", chatType: "private", userId: "owner", senderName: "测试", actorAuthorization: options.missingActor ? undefined : actorAuthorization },
    participantProfiles: [], promptMessages: [{ role: "user", content: "测试" }], resolvedModelRef: ["main"],
    availableToolNames: [options.tool], streamResponse: false,
    committedTextSink: { async commitText() {} }
  });
  assert.equal(providerCalls, 1, "必须实际到达生成入口");
  return { displayNames, outcome, handlerCalls };
}

test("真实 generation 在模型展示后启用功能，手写工具调用仍不得扩权", async () => {
  const result = await runBoundary({ source: "onebot", tool: "terminal_list", initiallyEnabled: false, afterDisplay: ({ config }) => { config.shell.enabled = true; } });
  assert.ok(!result.displayNames.includes("terminal_list"));
  assert.match(result.outcome, /error/);
  assert.equal(result.handlerCalls, 0);
});

test("生成边界对照：绑定保留且已展示的 owner 工具确实到达 handler", async () => {
  const result = await runBoundary({ source: "qq_official", tool: "terminal_list", afterDisplay() {} });
  assert.ok(result.displayNames.includes("terminal_list"));
  assert.equal(result.handlerCalls, 1);
  assert.equal(JSON.parse(result.outcome).ok, true);
});

test("真实官方会话撤销外部 owner 身份绑定后，旧 turn 不得继续 owner 工具", async () => {
  const result = await runBoundary({ source: "qq_official", tool: "terminal_list", afterDisplay: ({ revoke }) => revoke() });
  assert.ok(result.displayNames.includes("terminal_list"));
  assert.match(result.outcome, /error/);
  assert.equal(result.handlerCalls, 0);
});

test("真实 QQ 入站经 builder 和 pending 队列后转 Web 输出，解绑仍撤销旧 turn", async () => {
  const result = await runBoundary({ source: "qq_official", tool: "terminal_list", useAuthenticatedBuilder: true, afterDisplay: ({ revoke }) => revoke() });
  assert.ok(result.displayNames.includes("terminal_list"));
  assert.match(result.outcome, /error/);
  assert.equal(result.handlerCalls, 0);
});

test("旧 pending 缺少可信触发者授权时拒绝工具，不反查任意绑定补权", async () => {
  const result = await runBoundary({ source: "qq_official", tool: "terminal_list", missingActor: true, afterDisplay() {} });
  assert.match(result.outcome, /error/);
  assert.equal(result.handlerCalls, 0);
});

test("真实 generation 展示后关闭会话工具集，执行立即收紧", async () => {
  const result = await runBoundary({ source: "qq_official", tool: "terminal_list", afterDisplay({ sessions, sessionId }) {
    const session = sessions.getSession(sessionId);
    sessions.setSettings(sessionId, { pacingPreferences: session.pacingPreferences, modelRoutingPreferences: session.modelRoutingPreferences, toolsetPreferences: { overrides: { shell_runtime: "disabled" } } });
  } });
  assert.ok(result.displayNames.includes("terminal_list"));
  assert.match(result.outcome, /error/);
  assert.equal(result.handlerCalls, 0);
});

test("真实 generation 展示后进入角色配置阶段，旧工具调用立即失效", async () => {
  const result = await runBoundary({ source: "qq_official", tool: "terminal_list", afterDisplay({ sessions, sessionId }) {
    sessions.setOperationMode(sessionId, { kind: "character_config", stage: "persona" });
  } });
  assert.ok(result.displayNames.includes("terminal_list"));
  assert.match(result.outcome, /error/);
  assert.equal(result.handlerCalls, 0);
});

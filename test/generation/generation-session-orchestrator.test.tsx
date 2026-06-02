import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";
import type { SessionTaskTracker } from "../../src/conversation/taskTracker/taskTrackerTypes.ts";

type TestPromptHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type TestPromptBatchMessage = {
  text: string;
};

function createFakeShellRuntime() {
  return {
    isInputPromptCurrent() {
      return true;
    }
  };
}

test("persona setup prompt reads the current draft instead of the saved persona", async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true
    }
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:2254600711";
  sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "onebot"
  });
  sessionManager.setOperationMode(sessionId, {
    kind: "persona_setup",
    draft: createEmptyPersona()
  });
  sessionManager.appendPendingMessage(sessionId, {
    channelId: "qqbot",
    externalUserId: "2254600711",
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "重新开始设定",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false
  });

  const savedPersona = {
    ...createEmptyPersona(),
    name: "旧名字",
    temperament: "旧性格",
    voiceStyle: "旧语气"
  };

  let capturedPersona: unknown = null;
  let resolveRunGeneration!: () => void;
  const runGenerationDone = new Promise<void>((resolve) => {
    resolveRunGeneration = resolve;
  });

  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: {
      config
    } as any,
    sessionRuntime: {
      logger,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      },
      llmClient: {} as never,
      sessionCaptioner: {} as never,
      turnPlanner: {} as never,
      debounceManager: {} as never,
      sessionManager
    } as any,
    identity: {
      userStore: {
        async getByUserId(userId: string) {
          return {
            userId,
            relationship: "owner"
          };
        }
      },
      personaStore: {
        async get() {
          return savedPersona;
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: {
        async ensureForSession() {
          return { profile: { theme: "t", worldBaseline: "w", narrationStyle: "n", boundaries: "" } };
        }
      } as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "uninitialized",
            rp: "uninitialized",
            updatedAt: 1
          };
        }
      }
    } as any,
    toolRuntime: {
      shellRuntime: createFakeShellRuntime()
    } as any,
    lifecycle: {
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    } as any
  }, {
    promptBuilder: {
      async buildSetupPromptMessages(input: { persona: unknown }) {
        capturedPersona = input.persona;
        return {
          promptMessages: [{ role: "system" as const, content: "setup" }],
          debugSnapshot: {
            sessionId,
            systemMessages: ["setup"],
            visibleToolNames: [],
            activeToolsets: [],
            historySummary: null,
            recentHistory: [],
            currentBatch: [],
            liveResources: [],
            debugMarkers: [],
            toolTranscript: [],
            persona: input.persona as any,
            globalRules: [],
            toolsetRules: [],
            currentUser: null,
            participantProfiles: [],
            imageCaptions: [],
            lastLlmUsage: null
          }
        };
      }
    } as any,
    async runGeneration() {
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId, { skipReplyGate: true });
  await runGenerationDone;

  assert.deepEqual(capturedPersona, createEmptyPersona());
});

test("rp_assistant normal prompt receives the saved rp profile", async () => {
  const config = createTestAppConfig({ llm: { enabled: true } });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:2254600711";
  sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "onebot"
  });
  sessionManager.setModeId(sessionId, "rp_assistant");
  sessionManager.appendPendingMessage(sessionId, {
    channelId: "qqbot",
    externalUserId: "2254600711",
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "今晚几点回来",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false
  });

  const savedPersona = {
    ...createEmptyPersona(),
    name: "小满",
    temperament: "冷静",
    voiceStyle: "短句"
  };
  const savedRpProfile = {
    ...createEmptyRpProfile(),
    identity: "图书管理员",
    background: "",
    continuityFacts: "",
    boundaries: "绝不跳出角色"
  };

  let capturedModeProfile: unknown = null;
  let resolveRunGeneration!: () => void;
  const runGenerationDone = new Promise<void>((resolve) => {
    resolveRunGeneration = resolve;
  });

  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config } as any,
    sessionRuntime: {
      logger,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      },
      llmClient: {} as never,
      sessionCaptioner: {} as never,
      turnPlanner: {} as never,
      debounceManager: {} as never,
      sessionManager
    } as any,
    identity: {
      userStore: {
        async getByUserId(userId: string) {
          return {
            userId,
            relationship: "owner"
          };
        }
      },
      personaStore: {
        async get() {
          return savedPersona;
        }
      },
      rpProfileStore: {
        async get() {
          return savedRpProfile;
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: {
        async ensureForSession() {
          return { profile: { theme: "t", worldBaseline: "w", narrationStyle: "n", boundaries: "" } };
        }
      } as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            updatedAt: 1
          };
        }
      }
    } as any,
    toolRuntime: {
      shellRuntime: createFakeShellRuntime()
    } as any,
    lifecycle: {
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    } as any
  }, {
    promptBuilder: {
      async buildChatPromptMessages(input: { modeProfile?: unknown }) {
        capturedModeProfile = input.modeProfile;
        return {
          promptMessages: [{ role: "system" as const, content: "chat" }],
          debugSnapshot: {
            sessionId,
            systemMessages: ["chat"],
            visibleToolNames: [],
            activeToolsets: [],
            historySummary: null,
            recentHistory: [],
            currentBatch: [],
            liveResources: [],
            debugMarkers: [],
            toolTranscript: [],
            persona: savedPersona,
            globalRules: [],
            toolsetRules: [],
            currentUser: null,
            participantProfiles: [],
            imageCaptions: [],
            lastLlmUsage: null
          }
        };
      }
    } as any,
    async runGeneration() {
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId, { skipReplyGate: true });
  await runGenerationDone;

  assert.deepEqual(capturedModeProfile, {
    target: "rp",
    profile: savedRpProfile
  });
});

test("scenario_host normal prompt receives the saved scenario profile", async () => {
  const config = createTestAppConfig({ llm: { enabled: true } });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:2254600711";
  sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "onebot"
  });
  sessionManager.setModeId(sessionId, "scenario_host");
  sessionManager.appendPendingMessage(sessionId, {
    channelId: "qqbot",
    externalUserId: "2254600711",
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "开始主持",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false
  });

  const savedPersona = {
    ...createEmptyPersona(),
    name: "主持者",
    temperament: "克制",
    voiceStyle: "冷静"
  };
  const savedScenarioProfile = {
    ...createEmptyScenarioProfile(),
    theme: "都市怪谈",
    narrationStyle: "紧凑克制",
    worldBaseline: "现代都市潜伏超自然现象"
  };

  let capturedModeProfile: unknown = null;
  let resolveRunGeneration!: () => void;
  const runGenerationDone = new Promise<void>((resolve) => {
    resolveRunGeneration = resolve;
  });

  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config } as any,
    sessionRuntime: {
      logger,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      },
      llmClient: {} as never,
      sessionCaptioner: {} as never,
      turnPlanner: {} as never,
      debounceManager: {} as never,
      sessionManager
    } as any,
    identity: {
      userStore: {
        async getByUserId(userId: string) {
          return {
            userId,
            relationship: "owner"
          };
        }
      },
      personaStore: {
        async get() {
          return savedPersona;
        }
      },
      rpProfileStore: {
        async get() {
          throw new Error("scenario_host should not load rp profile");
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: {
        async ensureForSession() {
          return { profile: savedScenarioProfile };
        }
      } as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "uninitialized",
            updatedAt: 1
          };
        }
      }
    } as any,
    toolRuntime: {
      shellRuntime: createFakeShellRuntime()
    } as any,
    lifecycle: {
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    } as any
  }, {
    promptBuilder: {
      async buildChatPromptMessages(input: { modeProfile?: unknown }) {
        capturedModeProfile = input.modeProfile;
        return {
          promptMessages: [{ role: "system" as const, content: "chat" }],
          debugSnapshot: {
            sessionId,
            systemMessages: ["chat"],
            visibleToolNames: [],
            activeToolsets: [],
            historySummary: null,
            recentHistory: [],
            currentBatch: [],
            liveResources: [],
            debugMarkers: [],
            toolTranscript: [],
            persona: savedPersona,
            globalRules: [],
            toolsetRules: [],
            currentUser: null,
            participantProfiles: [],
            imageCaptions: [],
            lastLlmUsage: null
          }
        };
      }
    } as any,
    async runGeneration() {
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId, { skipReplyGate: true });
  await runGenerationDone;

  assert.deepEqual(capturedModeProfile, {
    target: "scenario",
    profile: savedScenarioProfile
  });
});

test("normal prompt provider replay excludes the active input batch", async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true,
      providers: {
        google: {
          type: "google",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "test-key",
          proxy: false
        }
      },
      models: {
        main: {
          provider: "google",
          model: "fake",
          modelType: "chat",
          supportsThinking: false,
          thinkingControllable: true,
          supportsVision: false,
          supportsAudioInput: false,
          supportsSearch: false,
          supportsTools: true,
          preserveThinking: false
        }
      }
    }
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:2254600711";
  sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "onebot"
  });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "旧问题"
  }, 1);
  sessionManager.appendAssistantHistory(sessionId, {
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "旧回答"
  }, 2);
  sessionManager.clearPendingTranscriptGroup(sessionId);
  sessionManager.appendUserHistory(sessionId, {
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "当前问题"
  }, 3);
  sessionManager.appendPendingMessage(sessionId, {
    channelId: "qqbot",
    externalUserId: "2254600711",
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "当前问题",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false
  });

  let capturedReplayMessages: Array<{ role: string; content: unknown }> = [];
  let capturedHistoryForPrompt: Array<{ role: string; content: string }> = [];
  let capturedBatchMessages: Array<{ text: string }> = [];
  let resolveRunGeneration!: () => void;
  const runGenerationDone = new Promise<void>((resolve) => {
    resolveRunGeneration = resolve;
  });

  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config } as any,
    sessionRuntime: {
      logger,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      },
      llmClient: {} as never,
      sessionCaptioner: {} as never,
      turnPlanner: {} as never,
      debounceManager: {} as never,
      sessionManager
    } as any,
    identity: {
      userStore: {
        async getByUserId(userId: string) {
          return {
            userId,
            relationship: "owner"
          };
        }
      },
      personaStore: {
        async get() {
          return createEmptyPersona();
        }
      },
      rpProfileStore: {
        async get() {
          return createEmptyRpProfile();
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: { async ensureForSession() { return { profile: { theme: "t", worldBaseline: "w", narrationStyle: "n", boundaries: "" } }; } } as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            updatedAt: 1
          };
        }
      }
    } as any,
    toolRuntime: {
      shellRuntime: createFakeShellRuntime()
    } as any,
    lifecycle: {
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    } as any
  }, {
    promptBuilder: {
      async buildChatPromptMessages(input: {
        replayMessages?: Array<{ role: string; content: unknown }>;
        historyForPrompt: Array<{ role: string; content: string }>;
        batchMessages: Array<{ text: string }>;
      }) {
        capturedReplayMessages = input.replayMessages ?? [];
        capturedHistoryForPrompt = input.historyForPrompt;
        capturedBatchMessages = input.batchMessages;
        return {
          promptMessages: [{ role: "system" as const, content: "chat" }],
          debugSnapshot: {
            sessionId,
            systemMessages: ["chat"],
            visibleToolNames: [],
            activeToolsets: [],
            historySummary: null,
            recentHistory: [],
            currentBatch: [],
            liveResources: [],
            debugMarkers: [],
            toolTranscript: [],
            persona: createEmptyPersona(),
            globalRules: [],
            toolsetRules: [],
            currentUser: null,
            participantProfiles: [],
            imageCaptions: [],
            lastLlmUsage: null
          }
        };
      }
    } as any,
    async runGeneration() {
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId, { skipReplyGate: true });
  await runGenerationDone;

  assert.equal(capturedReplayMessages.some((message) => String(message.content).includes("当前问题")), false);
  assert.equal(capturedReplayMessages.some((message) => String(message.content).includes("旧问题")), true);
  assert.equal(capturedHistoryForPrompt.length, 0);
  assert.deepEqual(capturedBatchMessages.map((message) => message.text), ["当前问题"]);
});

test("normal prompt history excludes active transcript group instead of subtracting batch count", async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true
    }
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:g:20001";
  sessionManager.ensureSession({
    id: sessionId,
    type: "group",
    source: "onebot"
  });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u1",
    senderName: "Alice",
    text: "@bot 当前问题"
  }, 10);
  sessionManager.appendPendingMessage(sessionId, {
    channelId: "qqbot",
    chatType: "group",
    userId: "u1",
    groupId: "20001",
    senderName: "Alice",
    text: "@bot 当前问题",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: true
  });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u2",
    senderName: "Bob",
    text: "中间插入的非当前批次消息"
  }, 20, { transcriptGroup: "standalone" });

  let capturedHistoryForPrompt: Array<{ role: string; content: string }> = [];
  let capturedBatchMessages: Array<{ text: string }> = [];
  let resolveRunGeneration!: () => void;
  const runGenerationDone = new Promise<void>((resolve) => {
    resolveRunGeneration = resolve;
  });

  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config } as any,
    sessionRuntime: {
      logger,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      },
      llmClient: {} as never,
      sessionCaptioner: {} as never,
      turnPlanner: {} as never,
      debounceManager: {} as never,
      sessionManager
    } as any,
    identity: {
      userStore: {
        async getByUserId(userId: string) {
          return {
            userId,
            relationship: "known"
          };
        }
      },
      personaStore: {
        async get() {
          return createEmptyPersona();
        }
      },
      rpProfileStore: {
        async get() {
          return createEmptyRpProfile();
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: { async ensureForSession() { return { profile: { theme: "t", worldBaseline: "w", narrationStyle: "n", boundaries: "" } }; } } as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            updatedAt: 1
          };
        }
      }
    } as any,
    toolRuntime: {
      shellRuntime: createFakeShellRuntime()
    } as any,
    lifecycle: {
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    } as any
  }, {
    promptBuilder: {
      async buildChatPromptMessages(input: {
        historyForPrompt: Array<{ role: string; content: string }>;
        batchMessages: Array<{ text: string }>;
      }) {
        capturedHistoryForPrompt = input.historyForPrompt;
        capturedBatchMessages = input.batchMessages;
        return {
          promptMessages: [{ role: "system" as const, content: "chat" }],
          debugSnapshot: {
            sessionId,
            systemMessages: ["chat"],
            visibleToolNames: [],
            activeToolsets: [],
            historySummary: null,
            recentHistory: [],
            currentBatch: [],
            liveResources: [],
            debugMarkers: [],
            toolTranscript: [],
            persona: createEmptyPersona(),
            globalRules: [],
            toolsetRules: [],
            currentUser: null,
            participantProfiles: [],
            imageCaptions: [],
            lastLlmUsage: null
          }
        };
      }
    } as any,
    async runGeneration() {
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId, { skipReplyGate: true });
  await runGenerationDone;

  assert.equal(capturedHistoryForPrompt.some((message) => message.content.includes("@bot 当前问题")), false);
  assert.equal(capturedHistoryForPrompt.some((message) => message.content.includes("中间插入的非当前批次消息")), true);
  assert.deepEqual(capturedBatchMessages.map((message) => message.text), ["@bot 当前问题"]);
});

test("normal prompt receives task tracker changes from the current user batch", async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true
    }
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:2254600711";
  sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "onebot"
  });
  sessionManager.setTaskTracker(sessionId, {
    version: 1,
    primary: {
      taskId: "task-1",
      status: "active",
      objective: "排查失败的测试",
      done: ["已运行初始测试"],
      next: ["继续定位失败原因"],
      blockers: [],
      importantToolRefs: [],
      createdAtMs: 1,
      updatedAtMs: 1
    },
    parked: [],
    evidence: []
  });
  sessionManager.appendPendingMessage(sessionId, {
    channelId: "qqbot",
    externalUserId: "2254600711",
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "算了，先这样",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false
  });

  let capturedTaskTracker: SessionTaskTracker | undefined;
  let resolveRunGeneration!: () => void;
  const runGenerationDone = new Promise<void>((resolve) => {
    resolveRunGeneration = resolve;
  });

  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config } as any,
    sessionRuntime: {
      logger,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      },
      llmClient: {} as never,
      sessionCaptioner: {} as never,
      turnPlanner: {} as never,
      debounceManager: {} as never,
      sessionManager
    } as any,
    identity: {
      userStore: {
        async getByUserId(userId: string) {
          return {
            userId,
            relationship: "owner"
          };
        }
      },
      personaStore: {
        async get() {
          return createEmptyPersona();
        }
      },
      rpProfileStore: {
        async get() {
          return createEmptyRpProfile();
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: { async ensureForSession() { return { profile: { theme: "t", worldBaseline: "w", narrationStyle: "n", boundaries: "" } }; } } as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            updatedAt: 1
          };
        }
      }
    } as any,
    toolRuntime: {
      shellRuntime: createFakeShellRuntime()
    } as any,
    lifecycle: {
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    } as any
  }, {
    promptBuilder: {
      async buildChatPromptMessages(input: { taskTracker?: SessionTaskTracker }) {
        capturedTaskTracker = input.taskTracker;
        return {
          promptMessages: [{ role: "system" as const, content: "chat" }],
          debugSnapshot: {
            sessionId,
            systemMessages: ["chat"],
            visibleToolNames: [],
            activeToolsets: [],
            historySummary: null,
            recentHistory: [],
            currentBatch: [],
            liveResources: [],
            debugMarkers: [],
            toolTranscript: [],
            persona: createEmptyPersona(),
            globalRules: [],
            toolsetRules: [],
            currentUser: null,
            participantProfiles: [],
            imageCaptions: [],
            lastLlmUsage: null
          }
        };
      }
    } as any,
    async runGeneration() {
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId, { skipReplyGate: true });
  await runGenerationDone;

  assert.equal(capturedTaskTracker?.primary?.status, "cancel_confirming");
  assert.deepEqual(capturedTaskTracker?.primary?.next, ["确认用户是要暂停、取消，还是稍后继续。"]);
});

test("normal prompt receives task tracker changes from turn planner intent", async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true,
      turnPlanner: {
        enabled: true
      }
    }
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:2254600711";
  sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "onebot"
  });
  sessionManager.setTaskTracker(sessionId, {
    version: 1,
    primary: {
      taskId: "task-1",
      status: "active",
      objective: "排查失败的测试",
      done: [],
      next: ["继续定位失败原因"],
      blockers: [],
      importantToolRefs: [],
      createdAtMs: 1,
      updatedAtMs: 1
    },
    parked: [],
    evidence: []
  });
  sessionManager.appendPendingMessage(sessionId, {
    channelId: "qqbot",
    externalUserId: "2254600711",
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "这个先放一边，我问个别的",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false
  });

  let capturedTaskTracker: SessionTaskTracker | undefined;
  let capturedPlannerTaskContext: unknown = null;
  let statusDuringTopicCompaction: string | null = null;
  let resolveRunGeneration!: () => void;
  const runGenerationDone = new Promise<void>((resolve) => {
    resolveRunGeneration = resolve;
  });

  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config } as any,
      sessionRuntime: {
        logger,
        historyCompressor: {
          async maybeCompress() {
            return false;
          },
          async compactOldHistoryKeepingRecent() {
            statusDuringTopicCompaction = sessionManager.getSession(sessionId).taskTracker.primary?.status ?? null;
            return false;
          }
        },
      llmClient: {
        isConfigured() {
          return true;
        }
      } as any,
      sessionCaptioner: {} as never,
      turnPlanner: {
        isEnabled() {
          return true;
        },
          async decide(input: { taskContext?: unknown }) {
            capturedPlannerTaskContext = input.taskContext;
            return {
              replyDecision: "reply_small",
              topicDecision: "new_topic",
              reason: "用户想先放下任务",
            requiredCapabilities: [],
            contextDependencies: [],
            recentDomainReuse: [],
            followupMode: "none",
            toolsetIds: [],
            taskIntent: {
              kind: "pause_current",
              confidence: "high"
            }
          };
        }
      } as any,
      debounceManager: {} as never,
      sessionManager
    } as any,
    identity: {
      userStore: {
        async getByUserId(userId: string) {
          return {
            userId,
            relationship: "owner"
          };
        }
      },
      personaStore: {
        async get() {
          return createEmptyPersona();
        }
      },
      rpProfileStore: {
        async get() {
          return createEmptyRpProfile();
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: { async ensureForSession() { return { profile: { theme: "t", worldBaseline: "w", narrationStyle: "n", boundaries: "" } }; } } as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            updatedAt: 1
          };
        }
      }
    } as any,
    toolRuntime: {
      shellRuntime: createFakeShellRuntime()
    } as any,
    lifecycle: {
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    } as any
  }, {
    promptBuilder: {
      async buildChatPromptMessages(input: { taskTracker?: SessionTaskTracker }) {
        capturedTaskTracker = input.taskTracker;
        return {
          promptMessages: [{ role: "system" as const, content: "chat" }],
          debugSnapshot: {
            sessionId,
            systemMessages: ["chat"],
            visibleToolNames: [],
            activeToolsets: [],
            historySummary: null,
            recentHistory: [],
            currentBatch: [],
            liveResources: [],
            debugMarkers: [],
            toolTranscript: [],
            persona: createEmptyPersona(),
            globalRules: [],
            toolsetRules: [],
            currentUser: null,
            participantProfiles: [],
            imageCaptions: [],
            lastLlmUsage: null
          }
        };
      }
    } as any,
    async runGeneration() {
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId);
  await runGenerationDone;

  assert.deepEqual(capturedPlannerTaskContext, {
    primary: {
      taskId: "task-1",
      status: "active",
      objective: "排查失败的测试",
      next: "继续定位失败原因"
    },
    parked: []
  });
  assert.equal(capturedTaskTracker?.primary?.status, "suspended");
  assert.equal(statusDuringTopicCompaction, "suspended");
});

test("turn planner receives content-safety projected history and batch", async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true
    }
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:2254600711";
  sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "onebot"
  });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "历史原文"
  }, 1, { transcriptGroup: "standalone" });
  sessionManager.appendAssistantHistory(sessionId, {
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "历史回答"
  }, 2);
  sessionManager.appendPendingMessage(sessionId, {
    channelId: "qqbot",
    externalUserId: "2254600711",
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text: "当前原文",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false
  });

  let capturedPlannerBatchMessages: Array<{ text: string }> = [];
  let capturedPlannerHistory: Array<{ role: string; content: string }> = [];
  let capturedRunGenerationBatchMessages: Array<{ text: string }> = [];
  let resolveRunGeneration!: () => void;
  const runGenerationDone = new Promise<void>((resolve) => {
    resolveRunGeneration = resolve;
  });

  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: {
      config,
      contentSafetyService: {
        async projectPromptMessages<
          H extends TestPromptHistoryMessage,
          B extends TestPromptBatchMessage
        >(input: {
          recentMessages: H[];
          batchMessages: B[];
        }) {
          return {
            recentMessages: input.recentMessages.map((message) => (message.role === "user"
              ? { ...message, content: "<内容安全: history>" } as H
              : message)),
            batchMessages: input.batchMessages.map((message) => ({
              ...message,
              text: "<内容安全: batch>"
            } as B)),
            events: []
          };
        },
        async projectLlmMessages(input: { messages: unknown[] }) {
          return { ...input, events: [] };
        }
      }
    } as any,
    sessionRuntime: {
      logger,
      historyCompressor: {
        async maybeCompress() {
          return false;
        },
        async compactOldHistoryKeepingRecent() {
          return false;
        }
      },
      llmClient: {
        isConfigured() {
          return true;
        }
      } as any,
      sessionCaptioner: {} as never,
      turnPlanner: {
        isEnabled() {
          return true;
        },
        async decide(input: {
          recentMessages: Array<{ role: string; content: string }>;
          batchMessages: Array<{ text: string }>;
        }) {
          capturedPlannerHistory = input.recentMessages;
          capturedPlannerBatchMessages = input.batchMessages;
          return {
            replyDecision: "reply_small",
            topicDecision: "continue_topic",
            reason: "ok",
            requiredCapabilities: [],
            contextDependencies: [],
            recentDomainReuse: [],
            followupMode: "none",
            toolsetIds: []
          };
        }
      } as any,
      debounceManager: {} as never,
      sessionManager
    } as any,
    identity: {
      userStore: {
        async getByUserId(userId: string) {
          return {
            userId,
            relationship: "owner"
          };
        }
      },
      personaStore: {
        async get() {
          return createEmptyPersona();
        }
      },
      rpProfileStore: {
        async get() {
          return createEmptyRpProfile();
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: { async ensureForSession() { return { profile: { theme: "t", worldBaseline: "w", narrationStyle: "n", boundaries: "" } }; } } as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            updatedAt: 1
          };
        }
      }
    } as any,
    toolRuntime: {
      shellRuntime: createFakeShellRuntime()
    } as any,
    lifecycle: {
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    } as any
  }, {
    promptBuilder: {
      async buildChatPromptMessages() {
        return {
          promptMessages: [{ role: "system" as const, content: "chat" }],
          debugSnapshot: {
            sessionId,
            systemMessages: ["chat"],
            visibleToolNames: [],
            activeToolsets: [],
            historySummary: null,
            recentHistory: [],
            currentBatch: [],
            liveResources: [],
            debugMarkers: [],
            toolTranscript: [],
            persona: createEmptyPersona(),
            globalRules: [],
            toolsetRules: [],
            currentUser: null,
            participantProfiles: [],
            imageCaptions: [],
            lastLlmUsage: null
          }
        };
      }
    } as any,
    async runGeneration(input: { batchMessages: Array<{ text: string }> }) {
      capturedRunGenerationBatchMessages = input.batchMessages;
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId);
  await runGenerationDone;

  assert.deepEqual(capturedPlannerHistory.map((message) => message.content), ["<内容安全: history>", "历史回答"]);
  assert.deepEqual(capturedPlannerBatchMessages.map((message) => message.text), ["<内容安全: batch>"]);
  assert.deepEqual(capturedRunGenerationBatchMessages.map((message) => message.text), ["<内容安全: batch>"]);
});

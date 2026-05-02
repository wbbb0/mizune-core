import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";

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
    speakingStyle: "旧语气",
    globalTraits: "旧身份"
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
      scenarioHostStateStore: {} as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "uninitialized",
            rp: "uninitialized",
            scenario: "uninitialized",
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
    speakingStyle: "短句",
    globalTraits: "图书管理员"
  };
  const savedRpProfile = {
    ...createEmptyRpProfile(),
    selfPositioning: "冷静克制，不轻易示弱",
    socialRole: "图书管理员",
    lifeContext: "雨夜同居",
    physicalPresence: "",
    bondToUser: "",
    closenessPattern: "",
    interactionPattern: "",
    realityContract: "始终按真人自处",
    continuityFacts: "",
    hardLimits: "绝不跳出角色"
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
      scenarioProfileStore: {
        async get() {
          throw new Error("rp_assistant should not load scenario profile");
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: {} as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            scenario: "uninitialized",
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
    speakingStyle: "冷静",
    globalTraits: "旁白"
  };
  const savedScenarioProfile = {
    ...createEmptyScenarioProfile(),
    theme: "都市怪谈",
    hostStyle: "紧凑克制",
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
      scenarioProfileStore: {
        async get() {
          return savedScenarioProfile;
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: {} as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "uninitialized",
            scenario: "ready",
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
      scenarioProfileStore: {
        async get() {
          return createEmptyScenarioProfile();
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: {} as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            scenario: "ready",
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
      scenarioProfileStore: {
        async get() {
          return createEmptyScenarioProfile();
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: {} as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            scenario: "ready",
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
              ? { ...message, content: "⟦内容安全: history⟧" } as H
              : message)),
            batchMessages: input.batchMessages.map((message) => ({
              ...message,
              text: "⟦内容安全: batch⟧"
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
      scenarioProfileStore: {
        async get() {
          return createEmptyScenarioProfile();
        }
      },
      setupStore: {} as never,
      scenarioHostStateStore: {} as never,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            scenario: "ready",
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
    async runGeneration() {
      resolveRunGeneration();
    },
    processNextSessionWork() {}
  });

  orchestrator.flushSession(sessionId);
  await runGenerationDone;

  assert.deepEqual(capturedPlannerHistory.map((message) => message.content), ["⟦内容安全: history⟧", "历史回答"]);
  assert.deepEqual(capturedPlannerBatchMessages.map((message) => message.text), ["⟦内容安全: batch⟧"]);
});

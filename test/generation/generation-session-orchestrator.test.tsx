import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";

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
    coreIdentity: "旧身份",
    personality: "旧性格",
    speechStyle: "旧语气"
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
            recentToolEvents: [],
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
    coreIdentity: "图书管理员",
    personality: "冷静",
    speechStyle: "短句"
  };
  const savedRpProfile = {
    ...createEmptyRpProfile(),
    premise: "雨夜同居",
    identityBoundary: "始终按真人自处",
    hardRules: "绝不跳出角色"
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
            recentToolEvents: [],
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
    coreIdentity: "旁白",
    personality: "克制",
    speechStyle: "冷静"
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
            recentToolEvents: [],
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

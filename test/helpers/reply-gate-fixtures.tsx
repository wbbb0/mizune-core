import pino from "pino";
import { TurnPlanner, type TurnPlannerInput } from "../../src/conversation/turnPlanner.ts";
import type { AppConfig } from "../../src/config/config.ts";
import type { LlmClient, LlmGenerateParams } from "../../src/llm/llmClient.ts";
import type { GenerationTurnPlannerHandlers, GenerationTurnPlannerInput } from "../../src/app/generation/generationTurnPlanner.ts";
import type { GenerationRunnerDeps } from "../../src/app/generation/generationRunnerDeps.ts";

export type ReplyGateBatchMessage = TurnPlannerInput["batchMessages"][number];
export type ReplyGateRecentMessage = TurnPlannerInput["recentMessages"][number];
type GenerationReplyGateDeps = Pick<GenerationRunnerDeps, "config" | "logger" | "llmClient" | "turnPlanner" | "debounceManager" | "historyCompressor" | "sessionManager" | "persistSession">;

interface ReplyGateHarnessOptions {
  resultText?: string;
  onGenerate?: (input: LlmGenerateParams) => void | Promise<void>;
}

export function createReplyGateBatchMessage(
  overrides: Partial<ReplyGateBatchMessage> = {}
): ReplyGateBatchMessage {
  return {
    senderName: "Owner",
    text: "hello",
    images: [],
    audioSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: Date.now(),
    ...overrides
  };
}

export function createReplyGate(
  config: AppConfig,
  options: ReplyGateHarnessOptions = {}
): TurnPlanner {
  const llmClient = {
    async generate(input: LlmGenerateParams) {
      await options.onGenerate?.(input);
      return { text: options.resultText ?? "继续处理|reply_small|continue_topic" };
    }
  } as unknown as LlmClient;

  const mediaVisionService = {
    async prepareFilesForModel() {
      throw new Error("should not prepare emoji images when vision is disabled");
    }
  } as unknown as GenerationRunnerDeps["mediaVisionService"];

  return new TurnPlanner(config, llmClient, {
    async getMany() {
      return [];
    }
  } as unknown as GenerationRunnerDeps["mediaWorkspace"], mediaVisionService, pino({ level: "silent" }));
}

export function createGenerationReplyGateDeps(
  overrides: Partial<GenerationReplyGateDeps> = {}
): GenerationReplyGateDeps {
  return {
    config: overrides.config ?? (null as unknown as GenerationRunnerDeps["config"]),
    logger: pino({ level: "silent" }),
    llmClient: {
      isConfigured() {
        return true;
      }
    } as GenerationRunnerDeps["llmClient"],
    turnPlanner: overrides.turnPlanner ?? ({
      isEnabled() {
        return true;
      },
      async decide() {
        return { replyDecision: "reply_small", topicDecision: "continue_topic", reason: "should not run", toolsetIds: [] };
      }
    } as unknown as GenerationRunnerDeps["turnPlanner"]),
    debounceManager: overrides.debounceManager ?? ({
      schedule() {
        throw new Error("unexpected debounce schedule");
      }
    } as unknown as GenerationRunnerDeps["debounceManager"]),
    historyCompressor: overrides.historyCompressor ?? ({
      async maybeCompress() {},
      async compactOldHistoryKeepingRecent() {}
    } as unknown as GenerationRunnerDeps["historyCompressor"]),
    sessionManager: overrides.sessionManager ?? ({
      requeuePendingMessages() {
        throw new Error("unexpected message requeue");
      }
    } as unknown as GenerationRunnerDeps["sessionManager"]),
    persistSession: overrides.persistSession ?? (() => undefined)
  };
}

export function createGenerationReplyGateHandlers(
  overrides: Partial<GenerationTurnPlannerHandlers> = {}
): GenerationTurnPlannerHandlers {
  return {
    flushSession() {},
    ...overrides
  };
}

export function createGenerationReplyGateInput(
  overrides: Partial<GenerationTurnPlannerInput> = {}
): GenerationTurnPlannerInput {
  return {
    sessionId: "private:audio",
    relationship: "owner",
    currentUser: null,
    sendTarget: {
      delivery: "onebot",
      chatType: "private",
      userId: "10001",
      senderName: "Tester"
    },
    historyForPrompt: [],
    pendingReplyGateWaitPasses: 0,
    availableToolsets: [],
    abortSignal: new AbortController().signal,
    batchMessages: [{
      chatType: "private",
      userId: "10001",
      senderName: "Tester",
      text: "",
      images: [],
      audioSources: ["https://example.com/audio/test.mp3"],
      audioIds: [],
      emojiSources: [],
      imageIds: [],
      emojiIds: [],
      attachments: [],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: false,
      receivedAt: Date.now()
    }],
    ...overrides
  };
}

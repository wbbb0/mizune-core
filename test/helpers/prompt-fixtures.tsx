import type { LlmContentPart, LlmMessage } from "../../src/llm/llmClient.ts";
import type {
  PromptBatchMessage,
  PromptUserProfile,
  ScheduledTaskPromptInput,
  SetupPromptInput
} from "../../src/llm/prompt/promptBuilder.ts";

export function createPromptBatchMessage(
  overrides: Partial<PromptBatchMessage> = {}
): PromptBatchMessage {
  return {
    userId: "owner",
    senderName: "Owner",
    text: "你好",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    attachments: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: Date.now(),
    ...overrides
  };
}

export function createPromptUserProfile(
  overrides: Partial<PromptUserProfile> = {}
): PromptUserProfile {
  return {
    ...overrides
  };
}

export function createScheduledTaskPromptOverrides(
  overrides: Partial<ScheduledTaskPromptInput> = {}
): Partial<ScheduledTaskPromptInput> {
  return overrides;
}

export function createSetupPromptOverrides(
  overrides: Partial<SetupPromptInput> = {}
): Partial<SetupPromptInput> {
  return overrides;
}

function readTextPart(part: LlmContentPart): string {
  return part.type === "text" ? part.text : "";
}

export function readPromptMessageText(message: LlmMessage | undefined): string {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map(readTextPart).filter(Boolean).join("\n");
}

import type { LlmContentPart, LlmMessage } from "../../src/llm/llmClient.ts";
import type {
  PromptBatchMessage,
  PromptUserProfile,
  ScheduledTaskPromptInput,
  SetupPromptInput
} from "../../src/llm/prompt/promptBuilder.ts";
import { parseProtocolLine } from "../../src/utils/structuredEnvelope.ts";

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

export function readPromptSystemText(messages: LlmMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map(readPromptMessageText)
    .filter(Boolean)
    .join("\n");
}

export function readPromptLastMessageText(messages: LlmMessage[]): string {
  return readPromptMessageText(messages[messages.length - 1]);
}

export interface ParsedPromptBlock {
  tag: string;
  attrs: Record<string, string>;
  body: string;
}

export function parsePromptBlocks(text: string): ParsedPromptBlock[] {
  const blocks: ParsedPromptBlock[] = [];
  const stack: Array<{
    tag: string;
    attrs: Record<string, string>;
    lines: string[];
  }> = [];

  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    const parsed = parseProtocolLine(line);
    if (!parsed) {
      for (const frame of stack) {
        frame.lines.push(line);
      }
      continue;
    }

    if (parsed.closing) {
      const frame = stack.pop();
      if (frame && frame.tag === parsed.tag) {
        blocks.push({
          tag: frame.tag,
          attrs: frame.attrs,
          body: frame.lines.join("\n").trim()
        });
      }
      continue;
    }

    stack.push({
      tag: parsed.tag,
      attrs: parsed.attrs,
      lines: []
    });
  }

  return blocks;
}

export function findPromptSection(text: string, name: string): ParsedPromptBlock | undefined {
  return parsePromptBlocks(text).find((block) => block.tag === "section" && block.attrs.name === name);
}

export function hasPromptSection(text: string, name: string): boolean {
  return findPromptSection(text, name) !== undefined;
}

export function findPromptBlock(text: string, tag: string): ParsedPromptBlock | undefined {
  return parsePromptBlocks(text).find((block) => block.tag === tag);
}

export function findPromptProtocolLine(text: string, tag: string): { attrs: Record<string, string> } | undefined {
  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    const parsed = parseProtocolLine(line);
    if (parsed && !parsed.closing && parsed.tag === tag) {
      return { attrs: parsed.attrs };
    }
  }
  return undefined;
}

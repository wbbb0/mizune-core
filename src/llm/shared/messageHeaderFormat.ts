export interface MessageBatchHeaderInput {
  sessionLabel: string;
  triggerLabel: string;
  messageCount: number;
  speakerCount: number;
}

export interface MessageItemHeaderInput {
  index: number;
  speakerLabel: string;
  isTriggerUser: boolean;
  timestampLabel: string;
}

const HEADER_VALUE_FALLBACK = "unknown";
const RESERVED_HEADER_CHARS = /[\n\r="⟦⟧]/g;

function sanitizeHeaderValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return HEADER_VALUE_FALLBACK;
  }
  return normalized.replace(RESERVED_HEADER_CHARS, (char) => {
    switch (char) {
      case "=":
        return "＝";
      case "\"":
        return "＂";
      case "⟦":
        return "［";
      case "⟧":
        return "］";
      default:
        return " ";
    }
  });
}

function buildHeaderTag(kind: string, fields: Array<[label: string, value: string | number]>): string {
  const renderedFields = fields.map(([label, value]) => `${label}="${sanitizeHeaderValue(String(value))}"`);
  return `⟦${kind}${renderedFields.length > 0 ? ` ${renderedFields.join(" ")}` : ""}⟧`;
}

export function formatConversationMessageHeader(timestampLabel: string): string {
  return buildHeaderTag("history_message", [["time", timestampLabel]]);
}

export function formatScheduledMessageHeader(role: "user" | "assistant", timestampLabel: string): string {
  return buildHeaderTag("scheduled_history_message", [
    ["role", role],
    ["time", timestampLabel]
  ]);
}

export function formatBatchMessageHeader(input: MessageBatchHeaderInput): string {
  return buildHeaderTag("trigger_batch", [
    ["session", input.sessionLabel],
    ["trigger_user", input.triggerLabel],
    ["message_count", input.messageCount],
    ["speaker_count", input.speakerCount]
  ]);
}

export function formatBatchItemMessageHeader(input: MessageItemHeaderInput): string {
  return buildHeaderTag("trigger_message", [
    ["index", input.index],
    ["speaker", input.speakerLabel],
    ["trigger_user", input.isTriggerUser ? "yes" : "no"],
    ["time", input.timestampLabel]
  ]);
}

export function formatDraftBatchMessageHeader(input: Omit<MessageBatchHeaderInput, "triggerLabel">): string {
  return buildHeaderTag("draft_batch", [
    ["session", input.sessionLabel],
    ["message_count", input.messageCount],
    ["speaker_count", input.speakerCount]
  ]);
}

export function formatDraftBatchItemMessageHeader(input: Omit<MessageItemHeaderInput, "isTriggerUser">): string {
  return buildHeaderTag("draft_message", [
    ["index", input.index],
    ["speaker", input.speakerLabel],
    ["time", input.timestampLabel]
  ]);
}

const LEADING_MESSAGE_HEADER_REGEX = /^(?:[\t ]*⟦(?:history_message|scheduled_history_message|trigger_batch|trigger_message|draft_batch|draft_message)\b[^⟧\n]*⟧[\t ]*(?:\r?\n|$))+/;
const LEADING_BLANK_LINES_REGEX = /^[\t ]*(?:\r?\n[\t ]*)+/;

export function stripLeadingMessageHeaders(text: string): string {
  const strippedHeaders = text.replace(LEADING_MESSAGE_HEADER_REGEX, "");
  return strippedHeaders.replace(LEADING_BLANK_LINES_REGEX, "");
}

import { buildOpenTag, escapeAttr, parseProtocolLine } from "#utils/structuredEnvelope.ts";

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

function sanitizeHeaderValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return HEADER_VALUE_FALLBACK;
  }
  return escapeAttr(normalized).replace(/=/g, "＝");
}

function buildHeaderTag(kind: string, fields: Array<[label: string, value: string | number]>): string {
  const fieldMap: Record<string, string> = {};
  for (const [label, val] of fields) {
    fieldMap[label] = sanitizeHeaderValue(String(val));
  }
  return buildOpenTag(kind, fieldMap);
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

const MESSAGE_HEADER_TAGS = new Set([
  "history_message",
  "scheduled_history_message",
  "trigger_batch",
  "trigger_message",
  "draft_batch",
  "draft_message"
]);
const LEADING_BLANK_LINES_REGEX = /^[\t ]*(?:\r?\n[\t ]*)+/;

export function stripLeadingMessageHeaders(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let firstBodyLine = 0;
  while (firstBodyLine < lines.length) {
    const parsed = parseProtocolLine(lines[firstBodyLine]!);
    if (!parsed || parsed.closing || !MESSAGE_HEADER_TAGS.has(parsed.tag)) {
      break;
    }
    firstBodyLine += 1;
  }
  const strippedHeaders = lines.slice(firstBodyLine).join("\n");
  return strippedHeaders.replace(LEADING_BLANK_LINES_REGEX, "");
}

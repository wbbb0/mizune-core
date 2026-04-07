import {
  formatConversationMessageHeader,
  formatScheduledMessageHeader
} from "#llm/shared/messageHeaderFormat.ts";
import type { PromptHistoryMessage } from "#llm/prompt/promptTypes.ts";

export function formatPromptTimestamp(timestampMs?: number | null): string {
  if (timestampMs == null) {
    return "unknown time";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestampMs));
}

export function formatConversationHistoryPromptMessage(message: PromptHistoryMessage): string {
  return [
    formatConversationMessageHeader(formatPromptTimestamp(message.timestampMs)),
    message.content,
    "⟦/history_message⟧"
  ].join("\n");
}

export function formatScheduledHistoryPromptMessage(message: PromptHistoryMessage): string {
  return [
    formatScheduledMessageHeader(message.role, formatPromptTimestamp(message.timestampMs)),
    message.content,
    "⟦/scheduled_history_message⟧"
  ].join("\n");
}

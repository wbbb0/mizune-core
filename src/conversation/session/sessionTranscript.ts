import type { AppConfig } from "#config/config.ts";
import { formatStructuredMediaReference, projectTranscriptMessageItemToHistoryMessage } from "./historyContext.ts";
import type {
  InternalTranscriptItem,
  TranscriptAssistantMessageItem,
  TranscriptUserMessageItem,
  SessionHistoryMessage,
  SessionState
} from "./sessionTypes.ts";

export function isTranscriptLlmVisible(item: InternalTranscriptItem): boolean {
  return item.llmVisible === true;
}

export function isTranscriptVisibleChatMessage(item: InternalTranscriptItem): boolean {
  return item.kind === "user_message" || item.kind === "assistant_message";
}

function isTranscriptHistoryMessage(item: InternalTranscriptItem): item is TranscriptUserMessageItem | TranscriptAssistantMessageItem {
  return item.kind === "user_message" || item.kind === "assistant_message";
}

export function projectLlmVisibleHistoryFromTranscript(
  transcript: InternalTranscriptItem[],
  config: AppConfig
): SessionHistoryMessage[] {
  const projected = transcript
    .filter(isTranscriptHistoryMessage)
    .map((item) => projectTranscriptMessageItemToHistoryMessage(item));
  return normalizeProjectedHistoryMessages(projected, config);
}

export function projectVisibleMessagesFromTranscript(transcript: InternalTranscriptItem[]): Array<{
  role: "user" | "assistant";
  content: string;
  timestampMs: number;
}> {
  return transcript
    .filter(isTranscriptHistoryMessage)
    .map((item) => projectTranscriptMessageItemToHistoryMessage(item));
}

export type ProjectedChatTimelineItem =
  | {
      kind: "text";
      role: "user" | "assistant";
      content: string;
      timestampMs: number;
    }
  | {
      kind: "image";
      role: "assistant";
      fileId: string | null;
      fileRef: string | null;
      sourceName: string | null;
      chatFilePath: string | null;
      sourcePath: string | null;
      messageId: number | null;
      toolName: "chat_file_send_to_chat" | "local_file_send_to_chat";
      captionText: string | null;
      timestampMs: number;
    };

export function projectChatTimelineFromTranscript(transcript: InternalTranscriptItem[]): ProjectedChatTimelineItem[] {
  const projected: ProjectedChatTimelineItem[] = [];
  for (const item of transcript) {
    if (item.kind === "user_message" || item.kind === "assistant_message") {
      projected.push({
        kind: "text" as const,
        role: item.role,
        content: item.text,
        timestampMs: item.timestampMs
      });
      continue;
    }

    if (item.kind === "outbound_media_message") {
      projected.push({
        kind: "image" as const,
        role: "assistant" as const,
        fileId: item.fileId,
        fileRef: item.fileRef,
        sourceName: item.sourceName,
        chatFilePath: item.chatFilePath,
        sourcePath: item.sourcePath,
        messageId: item.messageId,
        toolName: item.toolName,
        captionText: item.captionText ?? null,
        timestampMs: item.timestampMs
      });
    }
  }
  return projected;
}

export function projectCompressionHistorySnapshot(
  session: SessionState,
  config: AppConfig,
  triggerMessageCount: number,
  retainMessageCount: number
): {
  historySummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
  retainedMessages: SessionHistoryMessage[];
  transcriptStartIndexToKeep: number;
} | null {
  const llmVisibleItems = session.internalTranscript.filter(isTranscriptLlmVisible);
  const recentMessages = llmVisibleItems
    .filter(isTranscriptHistoryMessage)
    .map((item) => projectTranscriptMessageItemToHistoryMessage(item));
  if (recentMessages.length <= triggerMessageCount || recentMessages.length === 0) {
    return null;
  }

  const safeRetainCount = Math.max(0, Math.min(retainMessageCount, recentMessages.length - 1));
  const visibleHistorySplitIndex = Math.max(1, recentMessages.length - safeRetainCount);
  const llmVisibleSplitIndex = resolveLlmVisibleSplitIndex(llmVisibleItems, visibleHistorySplitIndex);
  const transcriptStartIndexToKeep = findTranscriptStartIndexForLlmVisibleOffset(
    session.internalTranscript,
    llmVisibleSplitIndex
  );
  const retainedMessages = projectLlmVisibleHistoryFromTranscript(
    session.internalTranscript.slice(transcriptStartIndexToKeep),
    config
  );
  const compressedMessageCount = Math.max(1, recentMessages.length - retainedMessages.length);

  return {
    historySummary: session.historySummary,
    messagesToCompress: recentMessages.slice(0, compressedMessageCount),
    retainedMessages,
    transcriptStartIndexToKeep
  };
}

function resolveLlmVisibleSplitIndex(
  llmVisibleItems: InternalTranscriptItem[],
  visibleHistorySplitIndex: number
): number {
  let historyMessageCount = 0;
  for (let index = 0; index < llmVisibleItems.length; index += 1) {
    const item = llmVisibleItems[index];
    if (!item) {
      continue;
    }
    if (isTranscriptHistoryMessage(item)) {
      historyMessageCount += 1;
      if (historyMessageCount === visibleHistorySplitIndex) {
        return advanceSplitIndexPastLeadingToolItems(llmVisibleItems, index + 1);
      }
    }
  }
  return llmVisibleItems.length;
}

function advanceSplitIndexPastLeadingToolItems(
  llmVisibleItems: InternalTranscriptItem[],
  splitIndex: number
): number {
  let nextIndex = splitIndex;
  while (nextIndex < llmVisibleItems.length) {
    const item = llmVisibleItems[nextIndex];
    if (!item || (item.kind !== "assistant_tool_call" && item.kind !== "tool_result")) {
      break;
    }
    nextIndex += 1;
  }
  return nextIndex;
}

function findTranscriptStartIndexForLlmVisibleOffset(
  transcript: InternalTranscriptItem[],
  llmVisibleOffset: number
): number {
  if (llmVisibleOffset <= 0) {
    return 0;
  }

  let llmVisibleCount = 0;
  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (!item || !isTranscriptLlmVisible(item)) {
      continue;
    }
    llmVisibleCount += 1;
    if (llmVisibleCount === llmVisibleOffset) {
      return index + 1;
    }
  }

  return transcript.length;
}

function normalizeProjectedHistoryMessages(
  recentMessages: SessionHistoryMessage[],
  config: AppConfig
): SessionHistoryMessage[] {
  let normalized = recentMessages;
  const maxRecentMessages = config.conversation.historyWindow.maxRecentMessages;
  if (normalized.length > maxRecentMessages) {
    normalized = normalized.slice(-maxRecentMessages);
  }

  const maxImageReferences = config.conversation.historyWindow.maxImageReferences;
  if (maxImageReferences <= 0) {
    return normalized.map((message) => ({
      ...message,
      content: replaceExcessImages(message.content, true)
    }));
  }

  let remainingImageBudget = maxImageReferences;
  const next = [...normalized];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (!message) {
      continue;
    }
    const { content, consumed } = replaceImagesKeepingLatest(message.content, remainingImageBudget);
    remainingImageBudget = Math.max(0, remainingImageBudget - consumed);
    next[index] = {
      ...message,
      content
    };
  }
  return next;
}

function replaceImagesKeepingLatest(content: string, keepCount: number): { content: string; consumed: number } {
  let seen = 0;
  const next = content.replace(/⟦ref\s+kind="(image|emoji)"\s+image_id="([^"]+)"\s*⟧/gi, (_full, kind, captured) => {
    const value = String(captured ?? "").trim();
    if (seen < keepCount) {
      seen += 1;
      return formatStructuredMediaReference(kind === "emoji" ? "emoji" : "image", value);
    }
    return formatStructuredMediaReference(kind === "emoji" ? "emoji" : "image", "omitted");
  });
  return {
    content: next,
    consumed: seen
  };
}

function replaceExcessImages(content: string, replaceAll: boolean): string {
  if (!replaceAll) {
    return content;
  }
  return content.replace(
    /⟦ref\s+kind="(image|emoji)"\s+image_id="[^"]+"\s*⟧/gi,
    (_full, kind) => formatStructuredMediaReference(kind === "emoji" ? "emoji" : "image", "omitted")
  );
}

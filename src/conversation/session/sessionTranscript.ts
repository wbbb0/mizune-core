import type { AppConfig } from "#config/config.ts";
import { formatStructuredMediaReference, projectTranscriptMessageItemToHistoryMessage } from "./historyContext.ts";
import type {
  InternalTranscriptItem,
  TranscriptSessionModeSwitchItem,
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

function isTranscriptHistoryMessage(
  item: InternalTranscriptItem
): item is TranscriptUserMessageItem | TranscriptAssistantMessageItem | TranscriptSessionModeSwitchItem {
  return item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "session_mode_switch";
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

interface TokenEstimationWeights {
  cjkTokens: number;
  nonAsciiTokens: number;
  asciiTokens: number;
}

// Estimates token count for a text string using a lightweight heuristic.
// CJK characters are typically 2 tokens in most tokenizers; ASCII ~4 chars/token.
export function estimateTokens(text: string, weights?: TokenEstimationWeights): number {
  const cjkTokens = weights?.cjkTokens ?? 2;
  const nonAsciiTokens = weights?.nonAsciiTokens ?? 1;
  const asciiTokens = weights?.asciiTokens ?? 0.25;
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0x4E00 && code <= 0x9FFF) // CJK Unified Ideographs
      || (code >= 0x3400 && code <= 0x4DBF) // CJK Extension A
      || (code >= 0x20000 && code <= 0x2A6DF) // CJK Extension B (surrogate pair range)
      || (code >= 0xF900 && code <= 0xFAFF) // CJK Compatibility Ideographs
      || (code >= 0x3000 && code <= 0x303F) // CJK Symbols and Punctuation
      || (code >= 0x30A0 && code <= 0x30FF) // Katakana
      || (code >= 0x3040 && code <= 0x309F) // Hiragana
      || (code >= 0xFF00 && code <= 0xFFEF) // Halfwidth/Fullwidth Forms
    ) {
      tokens += cjkTokens;
    } else if (code > 127) {
      tokens += nonAsciiTokens;
    } else {
      tokens += asciiTokens;
    }
  }
  return Math.ceil(tokens);
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
  return buildCompressionSnapshot(session, config, llmVisibleItems, recentMessages, visibleHistorySplitIndex);
}

export function projectCompressionHistorySnapshotByTokens(
  session: SessionState,
  config: AppConfig,
  triggerTokens: number,
  retainTokens: number
): {
  historySummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
  retainedMessages: SessionHistoryMessage[];
  transcriptStartIndexToKeep: number;
  estimatedTotalTokens: number;
} | null {
  const llmVisibleItems = session.internalTranscript.filter(isTranscriptLlmVisible);
  const recentMessages = llmVisibleItems
    .filter(isTranscriptHistoryMessage)
    .map((item) => projectTranscriptMessageItemToHistoryMessage(item));

  if (recentMessages.length === 0) {
    return null;
  }

  const weights = config.conversation.historyCompression.tokenEstimation;
  const estimatedTotalTokens = recentMessages.reduce((sum, msg) => sum + estimateTokens(msg.content, weights), 0);
  if (estimatedTotalTokens <= triggerTokens) {
    return null;
  }

  // Find the split point: retain recent messages whose cumulative tokens (newest first)
  // fit within the retainTokens budget, but always compress at least one message.
  let retainedTokens = 0;
  let retainedMessageCount = 0;
  for (let i = recentMessages.length - 1; i >= 1; i -= 1) {
    const msg = recentMessages[i]!;
    const msgTokens = estimateTokens(msg.content, weights);
    if (retainedTokens + msgTokens > retainTokens) {
      break;
    }
    retainedTokens += msgTokens;
    retainedMessageCount += 1;
  }

  const visibleHistorySplitIndex = Math.max(1, recentMessages.length - retainedMessageCount);
  const snapshot = buildCompressionSnapshot(session, config, llmVisibleItems, recentMessages, visibleHistorySplitIndex);
  if (!snapshot) {
    return null;
  }
  return { ...snapshot, estimatedTotalTokens };
}

function buildCompressionSnapshot(
  session: SessionState,
  config: AppConfig,
  llmVisibleItems: InternalTranscriptItem[],
  recentMessages: SessionHistoryMessage[],
  visibleHistorySplitIndex: number
): {
  historySummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
  retainedMessages: SessionHistoryMessage[];
  transcriptStartIndexToKeep: number;
} | null {
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
  if (compressedMessageCount === 0) {
    return null;
  }

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

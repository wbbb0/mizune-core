import type { AppConfig } from "#config/config.ts";
import { formatStructuredMediaReference, projectTranscriptMessageItemToHistoryMessage } from "./historyContext.ts";
import type { ToolObservationSummary } from "./toolObservation.ts";
import { getCachedOrEstimatedInputTokens } from "./transcriptTokenStats.ts";
import { estimateTokens } from "./tokenEstimator.ts";
export { estimateTokens } from "./tokenEstimator.ts";
import type {
  InternalAssistantToolCallItem,
  InternalToolResultItem,
  InternalTranscriptItem,
  TranscriptSessionModeSwitchItem,
  TranscriptAssistantMessageItem,
  TranscriptUserMessageItem,
  SessionHistoryMessage,
  SessionState
} from "./sessionTypes.ts";

export function isTranscriptRuntimeIncluded(item: InternalTranscriptItem): boolean {
  return item.runtimeExcluded !== true;
}

export function isTranscriptAmbient(item: InternalTranscriptItem): boolean {
  return item.runtimeVisibility === "ambient";
}

export function isTranscriptLlmVisible(item: InternalTranscriptItem): boolean {
  return item.llmVisible === true && isTranscriptRuntimeIncluded(item) && !isTranscriptAmbient(item);
}

export function isTranscriptVisibleChatMessage(item: InternalTranscriptItem): boolean {
  return isTranscriptRuntimeIncluded(item) && (item.kind === "user_message" || item.kind === "assistant_message");
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
    .filter(isTranscriptLlmVisible)
    .filter(isTranscriptHistoryMessage)
    .map((item) => projectTranscriptMessageItemToHistoryMessage(item));
  return normalizeProjectedHistoryMessages(projected, config);
}

export function projectLlmVisibleHistoryWithAmbientRecallFromTranscript(
  transcript: InternalTranscriptItem[],
  config: AppConfig,
  options: {
    excludeGroupId?: string | null;
    ambientMessageCount: number;
  }
): SessionHistoryMessage[] {
  const excludeGroupId = options.excludeGroupId ?? null;
  const ambientRecallIds = collectAmbientRecallIds(transcript, excludeGroupId, options.ambientMessageCount);

  const projected = transcript
    .filter((item) => !excludeGroupId || item.groupId !== excludeGroupId)
    .filter((item) => (
      isTranscriptLlmVisible(item)
      || (options.ambientMessageCount > 0 && isTranscriptAmbient(item) && ambientRecallIds.has(item.id ?? ""))
    ))
    .filter(isTranscriptHistoryMessage)
    .map((item) => projectPromptHistoryMessageWithAmbientMarker(item));
  return normalizeProjectedHistoryMessages(projected, config);
}

export function projectAmbientRecallFromTranscript(
  transcript: InternalTranscriptItem[],
  config: AppConfig,
  options: {
    excludeGroupId?: string | null;
    ambientMessageCount: number;
  }
): SessionHistoryMessage[] {
  const excludeGroupId = options.excludeGroupId ?? null;
  const ambientRecallIds = collectAmbientRecallIds(transcript, excludeGroupId, options.ambientMessageCount);

  const projected = transcript
    .filter((item) => !excludeGroupId || item.groupId !== excludeGroupId)
    .filter((item) => (
      isTranscriptLlmVisible(item)
      || (options.ambientMessageCount > 0 && isTranscriptAmbient(item) && ambientRecallIds.has(item.id ?? ""))
    ))
    .filter(isTranscriptHistoryMessage)
    .map((item) => projectPromptHistoryMessageWithAmbientMarker(item));
  return normalizeProjectedHistoryMessages(projected, config);
}

function collectAmbientRecallIds(
  transcript: InternalTranscriptItem[],
  excludeGroupId: string | null,
  ambientMessageCount: number
): Set<string> {
  if (ambientMessageCount <= 0) {
    return new Set();
  }
  return new Set(
    transcript
      .filter((item): item is TranscriptUserMessageItem => (
        item.kind === "user_message"
        && item.chatType === "group"
        && isTranscriptRuntimeIncluded(item)
        && isTranscriptAmbient(item)
        && item.llmVisible === true
        && (!excludeGroupId || item.groupId !== excludeGroupId)
      ))
      .slice(-ambientMessageCount)
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string")
  );
}

function projectPromptHistoryMessageWithAmbientMarker(
  item: TranscriptUserMessageItem | TranscriptAssistantMessageItem | TranscriptSessionModeSwitchItem
): SessionHistoryMessage {
  const message = projectTranscriptMessageItemToHistoryMessage(item);
  if (isTranscriptAmbient(item)) {
    return {
      ...message,
      content: `【群聊环境，仅供理解当前被召唤的问题】${message.content}`
    };
  }
  return message;
}

export function projectVisibleMessagesFromTranscript(transcript: InternalTranscriptItem[]): Array<{
  role: "user" | "assistant";
  content: string;
  timestampMs: number;
}> {
  return transcript
    .filter(isTranscriptRuntimeIncluded)
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
      if (item.runtimeExcluded === true) {
        continue;
      }
      projected.push({
        kind: "text" as const,
        role: item.role,
        content: item.text,
        timestampMs: item.timestampMs
      });
      continue;
    }

    if (item.kind === "outbound_media_message") {
      if (item.runtimeExcluded === true) {
        continue;
      }
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
  toolObservationsToCompress: ToolObservationSummary[];
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
  retainTokens: number,
  // Provider-reported input tokens from the last request. When provided, replaces
  // the heuristic sum for the trigger check (more accurate than character estimation).
  reportedInputTokens?: number
): {
  historySummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
  retainedMessages: SessionHistoryMessage[];
  toolObservationsToCompress: ToolObservationSummary[];
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
  // Include history summary tokens in the heuristic (it's part of every LLM request
  // but was previously excluded, causing underestimation when summaries grow large).
  const summaryTokens = session.historySummary ? estimateTokens(session.historySummary, weights) : 0;
  const messageTokens = llmVisibleItems
    .filter(isTranscriptHistoryMessage)
    .reduce((sum, item) => sum + getCachedOrEstimatedInputTokens(item, config), 0);
  // Include tool call and result tokens — these can be significant in tool-heavy sessions
  // (shell output, file contents, browser snapshots, etc.) and were previously unaccounted.
  // This only affects the trigger-side heuristic; the retain split still operates on messages.
  const toolCallTokens = llmVisibleItems
    .filter((item): item is InternalAssistantToolCallItem => item.kind === "assistant_tool_call")
    .reduce((sum, item) => sum + getCachedOrEstimatedInputTokens(item, config), 0);
  const toolResultTokens = llmVisibleItems
    .filter((item): item is InternalToolResultItem => item.kind === "tool_result")
    .reduce((sum, item) => sum + getCachedOrEstimatedInputTokens(item, config), 0);
  const estimatedTotalTokens = reportedInputTokens ?? (summaryTokens + messageTokens + toolCallTokens + toolResultTokens);
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
  toolObservationsToCompress: ToolObservationSummary[];
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
  const toolObservationsToCompress = collectToolObservationsToCompress(
    session.internalTranscript.slice(0, transcriptStartIndexToKeep)
  );
  const compressedMessageCount = Math.max(1, recentMessages.length - retainedMessages.length);
  if (compressedMessageCount === 0) {
    return null;
  }

  return {
    historySummary: session.historySummary,
    messagesToCompress: recentMessages.slice(0, compressedMessageCount),
    retainedMessages,
    toolObservationsToCompress,
    transcriptStartIndexToKeep
  };
}

function collectToolObservationsToCompress(items: InternalTranscriptItem[]): ToolObservationSummary[] {
  return items
    .filter(isTranscriptLlmVisible)
    .filter((item): item is InternalToolResultItem => item.kind === "tool_result" && item.observation != null)
    .filter((item) => item.observation!.includeInHistorySummary !== false)
    .map((item) => ({
      toolName: item.toolName,
      toolCallId: item.toolCallId,
      summary: item.observation!.summary,
      timestampMs: item.timestampMs,
      contentHash: item.observation!.contentHash,
      retention: item.observation!.retention,
      ...(item.observation!.resource ? { resource: item.observation!.resource } : {}),
      pinned: item.observation!.pinned
    }));
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

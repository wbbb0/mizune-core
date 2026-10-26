import type { AppConfig } from "#config/config.ts";
import { getRoutingPresetHistoryWindow } from "#llm/shared/modelRouting.ts";
import { parseProtocolLine } from "#utils/structuredEnvelope.ts";
import { formatStructuredMediaReference, projectTranscriptMessageItemToHistoryMessage } from "./historyContext.ts";
import type { ToolObservationSummary } from "./toolObservation.ts";
import { getCachedOrEstimatedInputTokens } from "./transcriptTokenStats.ts";
export { estimateTokens } from "./tokenEstimator.ts";
import type {
  InternalToolResultItem,
  InternalTranscriptItem,
  TranscriptProfilePhaseTransitionItem,
  TranscriptSessionModeSwitchItem,
  TranscriptAssistantMessageItem,
  TranscriptUserMediaMessageItem,
  TranscriptUserMessageItem,
  SessionHistoryMessage,
  SessionState
} from "./sessionTypes.ts";

export function isTranscriptRuntimeIncluded(item: InternalTranscriptItem): boolean {
  return item.runtimeExcluded !== true;
}

export function isTranscriptLlmVisible(item: InternalTranscriptItem): boolean {
  return item.llmVisible === true && isTranscriptRuntimeIncluded(item);
}

export function isTranscriptVisibleChatMessage(item: InternalTranscriptItem): boolean {
  return isTranscriptRuntimeIncluded(item) && (item.kind === "user_message" || item.kind === "user_media_message" || item.kind === "assistant_message");
}

function isTranscriptHistoryMessage(
  item: InternalTranscriptItem
): item is
  | TranscriptUserMessageItem
  | TranscriptUserMediaMessageItem
  | TranscriptAssistantMessageItem
  | TranscriptSessionModeSwitchItem
  | TranscriptProfilePhaseTransitionItem {
  return item.kind === "user_message"
    || item.kind === "user_media_message"
    || item.kind === "assistant_message"
    || item.kind === "session_mode_switch"
    || item.kind === "profile_phase_transition";
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
      mediaKind: "image" | "emoji";
      fileId: string | null;
      fileRef: string | null;
      sourceName: string | null;
      chatFilePath: string | null;
      sourcePath: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      messageId: number | null;
      toolName: "asset_send_to_chat" | "filesystem_send_to_chat" | "sticker_send";
      captionText: string | null;
      timestampMs: number;
    }
  | {
      kind: "file";
      role: "assistant";
      mediaKind: "file";
      fileId: string | null;
      fileRef: string | null;
      sourceName: string | null;
      chatFilePath: string | null;
      sourcePath: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      messageId: number | null;
      toolName: "asset_send_to_chat" | "filesystem_send_to_chat" | "sticker_send";
      captionText: string | null;
      timestampMs: number;
    };

export function projectChatTimelineFromTranscript(transcript: InternalTranscriptItem[]): ProjectedChatTimelineItem[] {
  const projected: ProjectedChatTimelineItem[] = [];
  for (const item of transcript) {
    if (item.kind === "user_message" || item.kind === "user_media_message" || item.kind === "assistant_message") {
      if (item.runtimeExcluded === true) {
        continue;
      }
      projected.push({
        kind: "text" as const,
        role: item.role,
        content: item.kind === "assistant_message" ? item.text : projectTranscriptMessageItemToHistoryMessage(item).content,
        timestampMs: item.timestampMs
      });
      continue;
    }

    if (item.kind === "outbound_media_message") {
      if (item.runtimeExcluded === true) {
        continue;
      }
      const base = {
        role: "assistant" as const,
        fileId: item.fileId,
        fileRef: item.fileRef,
        sourceName: item.sourceName,
        chatFilePath: item.chatFilePath,
        sourcePath: item.sourcePath,
        mimeType: item.mimeType ?? null,
        sizeBytes: item.sizeBytes ?? null,
        messageId: item.messageId,
        toolName: item.toolName,
        captionText: item.captionText ?? null,
        timestampMs: item.timestampMs
      };
      projected.push(item.mediaKind === "file"
        ? { ...base, kind: "file" as const, mediaKind: "file" as const }
        : { ...base, kind: "image" as const, mediaKind: item.mediaKind });
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

export function selectRequestCompressionSnapshot(
  session: SessionState,
  config: AppConfig,
  retainTokens: number
): {
  historySummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
  retainedMessages: SessionHistoryMessage[];
  toolObservationsToCompress: ToolObservationSummary[];
  transcriptStartIndexToKeep: number;
  compressedTimestamps: number[];
} | null {
  const llmVisibleItems = session.internalTranscript.filter(isTranscriptLlmVisible);
  const historyItems = llmVisibleItems.filter(isTranscriptHistoryMessage);
  const recentMessages = historyItems.map((item) => projectTranscriptMessageItemToHistoryMessage(item));

  if (recentMessages.length === 0) {
    return null;
  }

  const turnStarts = historyItems.flatMap((item, index) => (
    (item.kind === "user_message" || item.kind === "user_media_message")
    && (index === 0 || recentMessages[index - 1]?.role !== "user") ? [index] : []
  ));
  if (turnStarts.length < 2) return null;
  let retainedTokens = 0;
  let visibleHistorySplitIndex = turnStarts[turnStarts.length - 1]!;
  for (let turn = turnStarts.length - 1; turn >= 1; turn -= 1) {
    const start = turnStarts[turn]!;
    const end = turnStarts[turn + 1];
    const visibleStart = llmVisibleItems.indexOf(historyItems[start]!);
    const visibleEnd = end == null ? llmVisibleItems.length : llmVisibleItems.indexOf(historyItems[end]!);
    const turnTokens = llmVisibleItems.slice(visibleStart, visibleEnd)
      .reduce((total, item) => total + getCachedOrEstimatedInputTokens(item, config), 0);
    if (turn < turnStarts.length - 1 && retainedTokens + turnTokens > retainTokens) break;
    retainedTokens += turnTokens;
    visibleHistorySplitIndex = start;
  }

  const snapshot = buildCompressionSnapshot(session, config, llmVisibleItems, recentMessages, visibleHistorySplitIndex, true);
  if (!snapshot) {
    return null;
  }
  return snapshot;
}

function buildCompressionSnapshot(
  session: SessionState,
  config: AppConfig,
  llmVisibleItems: InternalTranscriptItem[],
  recentMessages: SessionHistoryMessage[],
  visibleHistorySplitIndex: number,
  protectRecentTurn = false
): {
  historySummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
  retainedMessages: SessionHistoryMessage[];
  toolObservationsToCompress: ToolObservationSummary[];
  transcriptStartIndexToKeep: number;
  compressedTimestamps: number[];
} | null {
  if (protectRecentTurn) {
    let lastUserIndex = recentMessages.length - 1;
    while (lastUserIndex >= 0 && recentMessages[lastUserIndex]?.role !== "user") lastUserIndex -= 1;
    if (lastUserIndex < 1) return null;
    visibleHistorySplitIndex = Math.min(visibleHistorySplitIndex, lastUserIndex);
    while (visibleHistorySplitIndex > 0 && recentMessages[visibleHistorySplitIndex]?.role !== "user") visibleHistorySplitIndex -= 1;
    if (visibleHistorySplitIndex === 0) return null;
  }
  const llmVisibleSplitIndex = resolveLlmVisibleSplitIndex(llmVisibleItems, visibleHistorySplitIndex);
  const transcriptStartIndexToKeep = findTranscriptStartIndexForLlmVisibleOffset(
    session.internalTranscript,
    llmVisibleSplitIndex
  );
  // Compression boundaries must not inherit the prompt's maxRecentMessages clipping.
  const retainedMessages = session.internalTranscript.slice(transcriptStartIndexToKeep)
    .filter(isTranscriptLlmVisible)
    .filter(isTranscriptHistoryMessage)
    .map(item => projectTranscriptMessageItemToHistoryMessage(item));
  const toolObservationsToCompress = collectToolObservationsToCompress(
    session.internalTranscript.slice(0, transcriptStartIndexToKeep)
  );
  const compressedMessageCount = Math.max(0, recentMessages.length - retainedMessages.length);
  if (compressedMessageCount === 0) {
    return null;
  }

  const retainedTimestamps = new Set(session.internalTranscript.slice(transcriptStartIndexToKeep).map(item => item.timestampMs));
  return {
    historySummary: session.historySummary,
    messagesToCompress: recentMessages.slice(0, compressedMessageCount),
    retainedMessages,
    toolObservationsToCompress,
    transcriptStartIndexToKeep,
    // Equal timestamps can occur in batches; keep ambiguous records rather than dropping unsummarized context.
    compressedTimestamps: [...new Set(session.internalTranscript.slice(0, transcriptStartIndexToKeep).filter(isTranscriptLlmVisible).map(item => item.timestampMs))]
      .filter(timestamp => !retainedTimestamps.has(timestamp))
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
  const historyWindow = getRoutingPresetHistoryWindow(config);
  const maxRecentMessages = historyWindow.maxRecentMessages;
  if (normalized.length > maxRecentMessages) {
    normalized = normalized.slice(-maxRecentMessages);
  }

  const maxImageReferences = historyWindow.maxImageReferences;
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
  const next = content.replace(/\r\n/g, "\n").split("\n").map((line) => {
    const parsed = parseProtocolLine(line);
    if (!parsed || parsed.tag !== "ref" || (parsed.attrs.kind !== "image" && parsed.attrs.kind !== "emoji")) {
      return line;
    }
    const value = String(parsed.attrs.image_id ?? "").trim();
    if (seen < keepCount) {
      seen += 1;
      return formatStructuredMediaReference(parsed.attrs.kind === "emoji" ? "emoji" : "image", value);
    }
    return formatStructuredMediaReference(parsed.attrs.kind === "emoji" ? "emoji" : "image", "omitted");
  }).join("\n");
  return {
    content: next,
    consumed: seen
  };
}

function replaceExcessImages(content: string, replaceAll: boolean): string {
  if (!replaceAll) {
    return content;
  }
  return content.replace(/\r\n/g, "\n").split("\n").map((line) => {
    const parsed = parseProtocolLine(line);
    if (!parsed || parsed.tag !== "ref" || (parsed.attrs.kind !== "image" && parsed.attrs.kind !== "emoji")) {
      return line;
    }
    return formatStructuredMediaReference(parsed.attrs.kind === "emoji" ? "emoji" : "image", "omitted");
  }).join("\n");
}

import type { AppConfig } from "#config/config.ts";
import {
  appendInternalTranscriptState,
  applyCompressedHistoryState,
  setLastAssistantMessageReasoningState,
  setLastLlmUsageState
} from "./sessionMutations.ts";
import {
  cloneSessionState,
  getSessionViewSnapshot
} from "./sessionQueries.ts";
import { projectLlmVisibleHistoryFromTranscript, projectVisibleMessagesFromTranscript } from "./sessionTranscript.ts";
import {
  createAssistantTranscriptMessageItem,
  createSessionModeSwitchTranscriptItem,
  createUserTranscriptMessageItem
} from "./historyContext.ts";
import {
  createTranscriptGroupId,
  ensurePendingTranscriptGroupId,
  normalizeTranscriptItem,
  resolveTranscriptOutputGroupId
} from "./transcriptMetadata.ts";
import {
  distributeProviderOutputTokenStats,
  withEstimatedInputTokenStats
} from "./transcriptTokenStats.ts";
import { createSessionTranscriptStore } from "./sessionTranscriptStore.ts";
import type {
  InternalTranscriptItem,
  SessionMessage,
  SessionSentMessage,
  SessionState,
  SessionUsageSnapshot,
  TranscriptAssistantMessageItem,
  TranscriptItemDeliveryRef,
  TranscriptItemRuntimeExclusionReason,
  TranscriptItemSourceRef
} from "./sessionTypes.ts";
import type { ToolObservationSummary } from "./toolObservation.ts";

// Owns transcript/history bookkeeping and the projections derived from it.
// This keeps lifecycle control separate from the session's conversational record.
export class SessionHistoryService {
  constructor(private readonly config: AppConfig) { }

  private getTranscriptStore(session: SessionState) {
    return createSessionTranscriptStore(session, this.config);
  }

  private appendNormalizedTranscript(session: SessionState, item: InternalTranscriptItem, groupId: string): void {
    appendInternalTranscriptState(session, withEstimatedInputTokenStats(
      normalizeTranscriptItem(item, groupId),
      this.config
    ));
  }

  private appendHistoryTranscript(session: SessionState, item: InternalTranscriptItem, groupId: string): void {
    this.appendNormalizedTranscript(session, item, groupId);
    session.historyRevision += 1;
  }

  private createUserHistoryTranscriptItem(
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      specialSegments?: SessionMessage["specialSegments"];
      audioCount?: number;
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
      mentionedAll?: boolean;
      mentionedSelf?: boolean;
      sourceRef?: TranscriptItemSourceRef;
      contentSafetyEvents?: import("./sessionTypes.ts").TranscriptContentSafetyEvent[];
    },
    timestampMs: number
  ) {
    return createUserTranscriptMessageItem({
      chatType: message.chatType,
      userId: message.userId,
      senderName: message.senderName,
      text: message.text,
      ...(message.imageIds ? { imageIds: message.imageIds } : {}),
      ...(message.emojiIds ? { emojiIds: message.emojiIds } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.specialSegments ? { specialSegments: message.specialSegments } : {}),
      ...(message.audioCount != null ? { audioCount: message.audioCount } : {}),
      ...(message.forwardIds ? { forwardIds: message.forwardIds } : {}),
      ...(message.replyMessageId !== undefined ? { replyMessageId: message.replyMessageId } : {}),
      ...(message.mentionUserIds ? { mentionUserIds: message.mentionUserIds } : {}),
      ...(message.mentionedAll !== undefined ? { mentionedAll: message.mentionedAll } : {}),
      ...(message.mentionedSelf !== undefined ? { mentionedSelf: message.mentionedSelf } : {}),
      ...(message.sourceRef ? { sourceRef: message.sourceRef } : {}),
      ...(message.contentSafetyEvents && message.contentSafetyEvents.length > 0 ? { contentSafetyEvents: message.contentSafetyEvents } : {}),
      timestampMs
    });
  }

  clone(session: SessionState): SessionState {
    return cloneSessionState(session);
  }

  appendSimpleHistory(
    session: SessionState,
    role: "user" | "assistant",
    content: string,
    timestampMs = Date.now()
  ): void {
    const defaultUserId = session.type === "private"
      ? session.participantRef.id
      : "unknown";

    this.appendHistoryTranscript(session, role === "user"
      ? createUserTranscriptMessageItem({
          chatType: session.type,
          userId: defaultUserId,
          senderName: defaultUserId,
          text: content,
          timestampMs
        })
      : createAssistantTranscriptMessageItem({
          chatType: session.type,
          userId: defaultUserId,
          senderName: defaultUserId,
          text: content,
          timestampMs
        }), role === "user"
      ? ensurePendingTranscriptGroupId(session)
      : resolveTranscriptOutputGroupId(session));
  }

  appendUserHistory(
    session: SessionState,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      specialSegments?: SessionMessage["specialSegments"];
      audioCount?: number;
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
      mentionedAll?: boolean;
      mentionedSelf?: boolean;
      sourceRef?: TranscriptItemSourceRef;
      contentSafetyEvents?: import("./sessionTypes.ts").TranscriptContentSafetyEvent[];
    },
    timestampMs = Date.now()
  ): void {
    if (message.sourceRef && this.hasSourceRef(session, message.sourceRef)) {
      return;
    }
    this.appendHistoryTranscript(
      session,
      this.createUserHistoryTranscriptItem(message, timestampMs),
      ensurePendingTranscriptGroupId(session)
    );
  }

  canInsertUserHistoryByTimestamp(
    session: SessionState,
    input: {
      sourceRef?: TranscriptItemSourceRef;
      timestampMs: number;
    }
  ): boolean {
    if (input.timestampMs < session.historyBackfillBoundaryMs) {
      return false;
    }
    return input.sourceRef == null || !this.hasSourceRef(session, input.sourceRef);
  }

  insertUserHistoryByTimestamp(
    session: SessionState,
    message: Parameters<SessionHistoryService["appendUserHistory"]>[1],
    timestampMs = Date.now()
  ): boolean {
    if (!this.canInsertUserHistoryByTimestamp(session, {
      ...(message.sourceRef ? { sourceRef: message.sourceRef } : {}),
      timestampMs
    })) {
      return false;
    }
    const item = withEstimatedInputTokenStats(
      normalizeTranscriptItem(this.createUserHistoryTranscriptItem(message, timestampMs), createTranscriptGroupId()),
      this.config
    );
    const insertIndex = findTranscriptInsertIndex(session.internalTranscript, timestampMs);
    session.internalTranscript.splice(insertIndex, 0, item);
    session.historyRevision += 1;
    return true;
  }

  hasSourceRef(session: SessionState, sourceRef: TranscriptItemSourceRef): boolean {
    return session.internalTranscript.some((item) => (
      item.sourceRef?.platform === sourceRef.platform
      && item.sourceRef.messageId === sourceRef.messageId
    ));
  }

  appendAssistantHistory(
    session: SessionState,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      deliveryRef?: TranscriptItemDeliveryRef;
    },
    timestampMs = Date.now()
  ): void {
    this.appendHistoryTranscript(session, createAssistantTranscriptMessageItem({
      ...message,
      timestampMs
    }), resolveTranscriptOutputGroupId(session));
  }

  appendModeSwitch(session: SessionState, fromModeId: string, toModeId: string, timestampMs = Date.now()): void {
    // Mode switches change the prompt-visible conversation context even without a
    // user/assistant message, so they still advance the history revision.
    this.appendNormalizedTranscript(session, createSessionModeSwitchTranscriptItem({
      fromModeId,
      toModeId,
      timestampMs
    }), resolveTranscriptOutputGroupId(session));
    session.historyRevision += 1;
  }

  appendInternalTranscript(session: SessionState, item: InternalTranscriptItem): void {
    this.appendNormalizedTranscript(session, item, item.groupId ?? resolveTranscriptOutputGroupId(session));
    if (item.llmVisible === true) {
      session.historyRevision += 1;
    }
  }

  setLastLlmUsage(session: SessionState, usage: SessionUsageSnapshot): void {
    setLastLlmUsageState(session, usage);
  }

  setLastAssistantReasoning(session: SessionState, reasoningContent: string): boolean {
    return setLastAssistantMessageReasoningState(session, reasoningContent);
  }

  applyActiveResponseTokenStats(
    session: SessionState,
    input: {
      outputTokens: number | null;
      reasoningTokens: number | null;
      modelRef: string | null;
      model: string | null;
      providerReported: boolean;
      capturedAt: number;
    }
  ): boolean {
    const groupId = session.activeTranscriptGroupId;
    if (!groupId) {
      return false;
    }
    const matchingIndexes: number[] = [];
    const matchingItems: TranscriptAssistantMessageItem[] = [];
    for (let index = 0; index < session.internalTranscript.length; index += 1) {
      const item = session.internalTranscript[index];
      if (item?.kind === "assistant_message" && item.groupId === groupId) {
        matchingIndexes.push(index);
        matchingItems.push(item);
      }
    }
    if (matchingItems.length === 0) {
      return false;
    }
    const updated = distributeProviderOutputTokenStats({
      items: matchingItems,
      ...input,
      config: this.config
    });
    for (let index = 0; index < matchingIndexes.length; index += 1) {
      const transcriptIndex = matchingIndexes[index];
      const item = updated[index];
      if (transcriptIndex == null || !item) {
        continue;
      }
      session.internalTranscript[transcriptIndex] = item;
    }
    session.historyRevision += 1;
    return true;
  }

  getHistoryForCompression(
    session: SessionState,
    triggerMessageCount: number,
    retainMessageCount: number
  ): {
    historySummary: string | null;
    messagesToCompress: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    retainedMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    toolObservationsToCompress: ToolObservationSummary[];
    transcriptStartIndexToKeep: number;
  } | null {
    return this.getTranscriptStore(session).projectCompressionSnapshot(triggerMessageCount, retainMessageCount);
  }

  getHistoryForCompressionByTokens(
    session: SessionState,
    triggerTokens: number,
    retainTokens: number,
    reportedInputTokens?: number
  ): {
    historySummary: string | null;
    messagesToCompress: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    retainedMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    toolObservationsToCompress: ToolObservationSummary[];
    transcriptStartIndexToKeep: number;
    estimatedTotalTokens: number;
  } | null {
    return this.getTranscriptStore(session).projectCompressionSnapshotByTokens(
      triggerTokens,
      retainTokens,
      reportedInputTokens
    );
  }

  applyCompressedHistory(
    session: SessionState,
    payload: {
      historySummary: string;
      transcriptStartIndexToKeep: number;
    }
  ): void {
    applyCompressedHistoryState(session, payload);
  }

  getSessionView(session: SessionState): {
    id: string;
    type: "private" | "group";
    source: "onebot" | "web";
    modeId: string;
    participantUserId: string;
    participantLabel: string | null;
    debugControl: SessionState["debugControl"];
    historySummary: string | null;
    internalTranscript: InternalTranscriptItem[];
    debugMarkers: SessionState["debugMarkers"];
    lastLlmUsage: SessionUsageSnapshot | null;
    sentMessages: SessionSentMessage[];
    lastActiveAt: number;
  } {
    return getSessionViewSnapshot(session);
  }

  getLlmVisibleHistory(session: SessionState): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }> {
    return this.getTranscriptStore(session).projectRuntimeHistory();
  }

  getVisibleChatMessages(session: SessionState): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }> {
    return this.getTranscriptStore(session).projectVisibleMessages();
  }

  excludeTranscriptItem(
    session: SessionState,
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs = Date.now()
  ): InternalTranscriptItem[] {
    return this.getTranscriptStore(session).excludeItem(itemId, reason, timestampMs);
  }

  excludeTranscriptGroup(
    session: SessionState,
    groupId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs = Date.now()
  ): InternalTranscriptItem[] {
    return this.getTranscriptStore(session).excludeGroup(groupId, reason, timestampMs);
  }
}

function findTranscriptInsertIndex(items: InternalTranscriptItem[], timestampMs: number): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && item.timestampMs <= timestampMs) {
      return index + 1;
    }
  }
  return 0;
}

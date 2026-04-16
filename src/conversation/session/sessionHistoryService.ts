import type { AppConfig } from "#config/config.ts";
import {
  appendHistoryEntry,
  appendInternalTranscriptState,
  appendToolEventState,
  applyCompressedHistoryState,
  setLastAssistantMessageReasoningState,
  setLastLlmUsageState
} from "./sessionMutations.ts";
import {
  cloneSessionState,
  getHistoryForCompressionSnapshot,
  getHistoryForCompressionSnapshotByTokens,
  getSessionViewSnapshot
} from "./sessionQueries.ts";
import { projectLlmVisibleHistoryFromTranscript, projectVisibleMessagesFromTranscript } from "./sessionTranscript.ts";
import {
  createAssistantTranscriptMessageItem,
  createSessionModeSwitchTranscriptItem,
  createUserTranscriptMessageItem
} from "./historyContext.ts";
import type {
  InternalTranscriptItem,
  SessionMessage,
  SessionSentMessage,
  SessionState,
  SessionToolEvent,
  SessionUsageSnapshot
} from "./sessionTypes.ts";

// Owns transcript/history bookkeeping and the projections derived from it.
// This keeps lifecycle control separate from the session's conversational record.
export class SessionHistoryService {
  constructor(private readonly config: AppConfig) { }

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
      ? session.participantUserId
      : "unknown";

    appendHistoryEntry(session, role === "user"
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
        }));
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
      audioCount?: number;
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
      mentionedAll?: boolean;
      mentionedSelf?: boolean;
    },
    timestampMs = Date.now()
  ): void {
    appendHistoryEntry(session, createUserTranscriptMessageItem({
      chatType: message.chatType,
      userId: message.userId,
      senderName: message.senderName,
      text: message.text,
      ...(message.imageIds ? { imageIds: message.imageIds } : {}),
      ...(message.emojiIds ? { emojiIds: message.emojiIds } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.audioCount != null ? { audioCount: message.audioCount } : {}),
      ...(message.forwardIds ? { forwardIds: message.forwardIds } : {}),
      ...(message.replyMessageId !== undefined ? { replyMessageId: message.replyMessageId } : {}),
      ...(message.mentionUserIds ? { mentionUserIds: message.mentionUserIds } : {}),
      ...(message.mentionedAll !== undefined ? { mentionedAll: message.mentionedAll } : {}),
      ...(message.mentionedSelf !== undefined ? { mentionedSelf: message.mentionedSelf } : {}),
      timestampMs
    }));
  }

  appendAssistantHistory(
    session: SessionState,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
    },
    timestampMs = Date.now()
  ): void {
    appendHistoryEntry(session, createAssistantTranscriptMessageItem({
      ...message,
      timestampMs
    }));
  }

  appendModeSwitch(session: SessionState, fromModeId: string, toModeId: string, timestampMs = Date.now()): void {
    // Mode switches change the prompt-visible conversation context even without a
    // user/assistant message, so they still advance the history revision.
    appendInternalTranscriptState(session, createSessionModeSwitchTranscriptItem({
      fromModeId,
      toModeId,
      timestampMs
    }));
    session.historyRevision += 1;
  }

  appendInternalTranscript(session: SessionState, item: InternalTranscriptItem): void {
    appendInternalTranscriptState(session, item);
  }

  appendToolEvent(session: SessionState, event: SessionToolEvent): void {
    appendToolEventState(session, event);
  }

  setLastLlmUsage(session: SessionState, usage: SessionUsageSnapshot): void {
    setLastLlmUsageState(session, usage);
  }

  setLastAssistantReasoning(session: SessionState, reasoningContent: string): boolean {
    return setLastAssistantMessageReasoningState(session, reasoningContent);
  }

  getHistoryForCompression(
    session: SessionState,
    triggerMessageCount: number,
    retainMessageCount: number
  ): {
    historySummary: string | null;
    messagesToCompress: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    retainedMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    transcriptStartIndexToKeep: number;
  } | null {
    return getHistoryForCompressionSnapshot(session, this.config, triggerMessageCount, retainMessageCount);
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
    transcriptStartIndexToKeep: number;
    estimatedTotalTokens: number;
  } | null {
    return getHistoryForCompressionSnapshotByTokens(
      session,
      this.config,
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
    recentToolEvents: SessionToolEvent[];
    lastLlmUsage: SessionUsageSnapshot | null;
    sentMessages: SessionSentMessage[];
    lastActiveAt: number;
  } {
    return getSessionViewSnapshot(session);
  }

  getLlmVisibleHistory(session: SessionState): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }> {
    return projectLlmVisibleHistoryFromTranscript(session.internalTranscript, this.config);
  }

  getVisibleChatMessages(session: SessionState): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }> {
    return projectVisibleMessagesFromTranscript(session.internalTranscript);
  }
}

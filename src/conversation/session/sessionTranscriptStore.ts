import type { AppConfig } from "#config/config.ts";
import {
  projectCompressionHistorySnapshot,
  projectCompressionHistorySnapshotByTokens,
  projectLlmVisibleHistoryFromTranscript,
  projectVisibleMessagesFromTranscript,
  isTranscriptRuntimeIncluded
} from "./sessionTranscript.ts";
import { getTranscriptDeleteMessageId } from "./transcriptMetadata.ts";
import type {
  InternalTranscriptItem,
  SessionState,
  TranscriptItemRuntimeExclusionReason
} from "./sessionTypes.ts";

export interface SessionTranscriptStore {
  rawItems(): InternalTranscriptItem[];
  runtimeItems(): InternalTranscriptItem[];
  projectRuntimeHistory(): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  projectVisibleMessages(): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  projectCompressionSnapshot(
    triggerMessageCount: number,
    retainMessageCount: number
  ): ReturnType<typeof projectCompressionHistorySnapshot>;
  projectCompressionSnapshotByTokens(
    triggerTokens: number,
    retainTokens: number,
    reportedInputTokens?: number
  ): ReturnType<typeof projectCompressionHistorySnapshotByTokens>;
  excludeItem(
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs: number
  ): InternalTranscriptItem[];
  excludeGroup(
    groupId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs: number
  ): InternalTranscriptItem[];
}

export function createSessionTranscriptStore(session: SessionState, config: AppConfig): SessionTranscriptStore {
  return {
    rawItems() {
      return session.internalTranscript;
    },
    runtimeItems() {
      return session.internalTranscript.filter(isTranscriptRuntimeIncluded);
    },
    projectRuntimeHistory() {
      return projectLlmVisibleHistoryFromTranscript(session.internalTranscript, config);
    },
    projectVisibleMessages() {
      return projectVisibleMessagesFromTranscript(session.internalTranscript);
    },
    projectCompressionSnapshot(triggerMessageCount, retainMessageCount) {
      return projectCompressionHistorySnapshot(session, config, triggerMessageCount, retainMessageCount);
    },
    projectCompressionSnapshotByTokens(triggerTokens, retainTokens, reportedInputTokens) {
      return projectCompressionHistorySnapshotByTokens(session, config, triggerTokens, retainTokens, reportedInputTokens);
    },
    excludeItem(itemId, reason, timestampMs) {
      return applyRuntimeExclusion(session, (item) => item.id === itemId, reason, timestampMs);
    },
    excludeGroup(groupId, reason, timestampMs) {
      return applyRuntimeExclusion(session, (item) => item.groupId === groupId, reason, timestampMs);
    }
  };
}

function applyRuntimeExclusion(
  session: SessionState,
  predicate: (item: InternalTranscriptItem) => boolean,
  reason: TranscriptItemRuntimeExclusionReason,
  timestampMs: number
): InternalTranscriptItem[] {
  const affected: InternalTranscriptItem[] = [];
  const deletedMessageIds = new Set<number>();

  for (const item of session.internalTranscript) {
    if (!predicate(item) || item.runtimeExcluded === true) {
      continue;
    }
    item.runtimeExcluded = true;
    item.runtimeExcludedAt = timestampMs;
    item.runtimeExclusionReason = reason;
    affected.push(item);
    const messageId = getTranscriptDeleteMessageId(item);
    if (messageId != null) {
      deletedMessageIds.add(messageId);
    }
  }

  if (affected.length === 0) {
    return [];
  }

  if (deletedMessageIds.size > 0) {
    session.sentMessages = session.sentMessages.filter((message) => !deletedMessageIds.has(message.messageId));
  }
  session.historyRevision += 1;
  return affected;
}

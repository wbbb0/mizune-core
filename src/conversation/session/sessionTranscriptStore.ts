import { freezeTranscriptItem } from "./immutableTranscript.ts";
import type { AppConfig } from "#config/config.ts";
import {
  projectCompressionHistorySnapshot,
  selectRequestCompressionSnapshot,
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
  projectRuntimeHistoryExcludingGroup(groupId: string | null): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  projectRuntimeHistoryForPrompt(options: {
    excludeGroupId?: string | null;
  }): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  projectVisibleMessages(): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  projectCompressionSnapshot(
    triggerMessageCount: number,
    retainMessageCount: number
  ): ReturnType<typeof projectCompressionHistorySnapshot>;
  selectRequestCompressionSnapshot(
    retainTokens: number
  ): ReturnType<typeof selectRequestCompressionSnapshot>;
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
  excludeAfterItem(
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs: number
  ): InternalTranscriptItem[];
}

export function createSessionTranscriptStore(session: SessionState, config: AppConfig): SessionTranscriptStore {
  // steer 在模型请求边界单独注入；构建初始 prompt 时不能提前读入，否则会重复。
  const promptItems = () => session.pendingSteerMessages.length > 0 && session.pendingTranscriptGroupId
    ? session.internalTranscript.filter((item) => item.groupId !== session.pendingTranscriptGroupId)
    : session.internalTranscript;
  return {
    rawItems() {
      return session.internalTranscript;
    },
    runtimeItems() {
      return promptItems().filter(isTranscriptRuntimeIncluded);
    },
    projectRuntimeHistory() {
      return projectLlmVisibleHistoryFromTranscript(promptItems(), config);
    },
    projectRuntimeHistoryExcludingGroup(groupId) {
      if (!groupId) {
        return projectLlmVisibleHistoryFromTranscript(promptItems(), config);
      }
      return projectLlmVisibleHistoryFromTranscript(
        promptItems().filter((item) => item.groupId !== groupId),
        config
      );
    },
    projectRuntimeHistoryForPrompt(options) {
      return this.projectRuntimeHistoryExcludingGroup(options.excludeGroupId ?? null);
    },
    projectVisibleMessages() {
      return projectVisibleMessagesFromTranscript(session.internalTranscript);
    },
    projectCompressionSnapshot(triggerMessageCount, retainMessageCount) {
      return projectCompressionHistorySnapshot(session, config, triggerMessageCount, retainMessageCount);
    },
    selectRequestCompressionSnapshot(retainTokens) {
      return selectRequestCompressionSnapshot(session, config, retainTokens);
    },
    excludeItem(itemId, reason, timestampMs) {
      return applyRuntimeExclusion(session, (item) => item.id === itemId, reason, timestampMs);
    },
    excludeGroup(groupId, reason, timestampMs) {
      return applyRuntimeExclusion(session, (item) => item.groupId === groupId, reason, timestampMs);
    },
    excludeAfterItem(itemId, reason, timestampMs) {
      const boundaryIndex = session.internalTranscript.findIndex((item) => item.id === itemId);
      if (boundaryIndex === -1) {
        return [];
      }
      return applyRuntimeExclusion(
        session,
        (_item, index) => index > boundaryIndex,
        reason,
        timestampMs
      );
    }
  };
}

function applyRuntimeExclusion(
  session: SessionState,
  predicate: (item: InternalTranscriptItem, index: number) => boolean,
  reason: TranscriptItemRuntimeExclusionReason,
  timestampMs: number
): InternalTranscriptItem[] {
  const affected: InternalTranscriptItem[] = [];
  const deletedMessageIds = new Set<number>();

  for (const [index, item] of session.internalTranscript.entries()) {
    if (!predicate(item, index) || item.runtimeExcluded === true) {
      continue;
    }
    const updated = freezeTranscriptItem({ ...item, runtimeExcluded: true, runtimeExcludedAt: timestampMs, runtimeExclusionReason: reason });
    session.internalTranscript[index] = updated;
    affected.push(updated);
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
  const publishedIds = new Set(session.publishedConversation?.messages.map((message) => message.id));
  if (affected.some((item) => item.id != null && publishedIds.has(item.id))) {
    session.publishedConversation = null;
  }
  session.historyRevision += 1;
  return affected;
}

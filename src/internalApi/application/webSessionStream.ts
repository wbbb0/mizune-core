import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { ParsedWebSessionStreamQuery } from "../routeSupport.ts";

export type WebSessionPhase =
  | {
      kind: "idle";
      label: string;
    }
  | {
      kind: "waiting";
      label: string;
      pendingMessageCount: number;
    }
  | {
      kind: "reply_gate_wait";
      label: string;
      pendingMessageCount: number;
      waitPassCount: number;
    }
  | {
      kind: "generating";
      label: string;
    }
  | {
      kind: "tool_calling";
      label: string;
      toolNames: string[];
      lastToolName: string | null;
    }
  | {
      kind: "responding";
      label: string;
      previewText: string | null;
    };

export type WebSessionStreamEvent =
  | {
      type: "ready";
      sessionId: string;
      mutationEpoch: number;
      transcriptCount: number;
      pendingMessageCount: number;
      isGenerating: boolean;
      lastActiveAt: number;
      phase: WebSessionPhase;
      timestampMs: number;
    }
  | {
      type: "reset";
      sessionId: string;
      mutationEpoch: number;
      transcriptCount: number;
      pendingMessageCount: number;
      isGenerating: boolean;
      lastActiveAt: number;
      phase: WebSessionPhase;
      reason: "mutation_epoch_changed" | "transcript_cursor_ahead" | "transcript_gap_detected";
      timestampMs: number;
    }
  | {
      type: "status";
      sessionId: string;
      mutationEpoch: number;
      pendingMessageCount: number;
      isGenerating: boolean;
      lastActiveAt: number;
      phase: WebSessionPhase;
      timestampMs: number;
    }
  | {
      type: "transcript_item";
      sessionId: string;
      mutationEpoch: number;
      index: number;
      totalCount: number;
      eventId: string;
      item: InternalTranscriptItem;
      timestampMs: number;
    };

export type WebSessionStreamSnapshot = {
  sessionId: string;
  mutationEpoch: number;
  transcript: InternalTranscriptItem[];
  pendingMessageCount: number;
  pendingReplyGateWaitPasses: number;
  hasDebounceTimer: boolean;
  isGenerating: boolean;
  isResponding: boolean;
  lastActiveAt: number;
  activeAssistantResponseText: string | null;
  lastToolName: string | null;
};

export function buildInitialSessionStreamEvents(
  snapshot: WebSessionStreamSnapshot,
  query: ParsedWebSessionStreamQuery
): WebSessionStreamEvent[] {
  const readyEvent: WebSessionStreamEvent = {
    type: "ready",
    sessionId: snapshot.sessionId,
    mutationEpoch: snapshot.mutationEpoch,
    transcriptCount: snapshot.transcript.length,
    pendingMessageCount: snapshot.pendingMessageCount,
    isGenerating: snapshot.isGenerating,
    lastActiveAt: snapshot.lastActiveAt,
    phase: deriveWebSessionPhase(snapshot),
    timestampMs: Date.now()
  };
  const events: WebSessionStreamEvent[] = [readyEvent];

  if (
    query.mutationEpoch != null
    && query.mutationEpoch !== snapshot.mutationEpoch
  ) {
    events.push({
      type: "reset",
      sessionId: snapshot.sessionId,
      mutationEpoch: snapshot.mutationEpoch,
      transcriptCount: snapshot.transcript.length,
      pendingMessageCount: snapshot.pendingMessageCount,
      isGenerating: snapshot.isGenerating,
      lastActiveAt: snapshot.lastActiveAt,
      phase: deriveWebSessionPhase(snapshot),
      reason: "mutation_epoch_changed",
      timestampMs: Date.now()
    });
    return events;
  }

  if (query.transcriptCount > snapshot.transcript.length) {
    events.push({
      type: "reset",
      sessionId: snapshot.sessionId,
      mutationEpoch: snapshot.mutationEpoch,
      transcriptCount: snapshot.transcript.length,
      pendingMessageCount: snapshot.pendingMessageCount,
      isGenerating: snapshot.isGenerating,
      lastActiveAt: snapshot.lastActiveAt,
      phase: deriveWebSessionPhase(snapshot),
      reason: "transcript_cursor_ahead",
      timestampMs: Date.now()
    });
    return events;
  }

  if (query.transcriptCount < snapshot.transcript.length) {
    events.push(...buildTranscriptAppendEvents(snapshot, query.transcriptCount));
  }

  return events;
}

export function diffSessionStreamEvents(
  previous: WebSessionStreamSnapshot,
  current: WebSessionStreamSnapshot
): WebSessionStreamEvent[] {
  const events: WebSessionStreamEvent[] = [];

  if (current.mutationEpoch !== previous.mutationEpoch) {
    events.push({
      type: "reset",
      sessionId: current.sessionId,
      mutationEpoch: current.mutationEpoch,
      transcriptCount: current.transcript.length,
      pendingMessageCount: current.pendingMessageCount,
      isGenerating: current.isGenerating,
      lastActiveAt: current.lastActiveAt,
      phase: deriveWebSessionPhase(current),
      reason: "mutation_epoch_changed",
      timestampMs: Date.now()
    });
    return events;
  }

  if (current.transcript.length < previous.transcript.length) {
    events.push({
      type: "reset",
      sessionId: current.sessionId,
      mutationEpoch: current.mutationEpoch,
      transcriptCount: current.transcript.length,
      pendingMessageCount: current.pendingMessageCount,
      isGenerating: current.isGenerating,
      lastActiveAt: current.lastActiveAt,
      phase: deriveWebSessionPhase(current),
      reason: "transcript_gap_detected",
      timestampMs: Date.now()
    });
    return events;
  }

  if (current.transcript.length > previous.transcript.length) {
    events.push(...buildTranscriptAppendEvents(current, previous.transcript.length));
  }

  if (
    current.pendingMessageCount !== previous.pendingMessageCount
    || current.pendingReplyGateWaitPasses !== previous.pendingReplyGateWaitPasses
    || current.hasDebounceTimer !== previous.hasDebounceTimer
    || current.isGenerating !== previous.isGenerating
    || current.isResponding !== previous.isResponding
    || current.lastActiveAt !== previous.lastActiveAt
    || current.activeAssistantResponseText !== previous.activeAssistantResponseText
    || current.lastToolName !== previous.lastToolName
    || deriveWebSessionPhase(current).label !== deriveWebSessionPhase(previous).label
  ) {
    events.push({
      type: "status",
      sessionId: current.sessionId,
      mutationEpoch: current.mutationEpoch,
      pendingMessageCount: current.pendingMessageCount,
      isGenerating: current.isGenerating,
      lastActiveAt: current.lastActiveAt,
      phase: deriveWebSessionPhase(current),
      timestampMs: Date.now()
    });
  }

  return events;
}

function buildTranscriptAppendEvents(
  snapshot: WebSessionStreamSnapshot,
  startIndex: number
): WebSessionStreamEvent[] {
  const events: WebSessionStreamEvent[] = [];

  for (let index = startIndex; index < snapshot.transcript.length; index += 1) {
    const item = snapshot.transcript[index];
    if (!item) {
      continue;
    }

    events.push({
      type: "transcript_item",
      sessionId: snapshot.sessionId,
      mutationEpoch: snapshot.mutationEpoch,
      index,
      totalCount: snapshot.transcript.length,
      eventId: buildTranscriptEventId(snapshot.mutationEpoch, index),
      item,
      timestampMs: Date.now()
    });
  }

  return events;
}

function buildTranscriptEventId(mutationEpoch: number, index: number): string {
  return `transcript:${mutationEpoch}:${index}`;
}

function deriveWebSessionPhase(snapshot: WebSessionStreamSnapshot): WebSessionPhase {
  if (snapshot.isResponding && snapshot.activeAssistantResponseText != null) {
    return {
      kind: "responding",
      label: "正在输出回复",
      previewText: summarizePreviewText(snapshot.activeAssistantResponseText)
    };
  }

  const activeToolNames = collectActiveToolNames(snapshot.transcript);
  if (snapshot.isGenerating && activeToolNames.length > 0) {
    return {
      kind: "tool_calling",
      label: `正在调用工具：${activeToolNames.join("、")}`,
      toolNames: activeToolNames,
      lastToolName: snapshot.lastToolName
    };
  }

  if (snapshot.isGenerating) {
    return {
      kind: "generating",
      label: "正在生成回复"
    };
  }

  if (snapshot.hasDebounceTimer || snapshot.pendingMessageCount > 0) {
    if (snapshot.pendingReplyGateWaitPasses > 0) {
      return {
        kind: "reply_gate_wait",
        label: `等待门限判定后重试（第 ${snapshot.pendingReplyGateWaitPasses} 次）`,
        pendingMessageCount: snapshot.pendingMessageCount,
        waitPassCount: snapshot.pendingReplyGateWaitPasses
      };
    }
    return {
      kind: "waiting",
      label: snapshot.pendingMessageCount > 0
        ? `等待处理消息（${snapshot.pendingMessageCount} 条）`
        : "等待 debounce 窗口结束"
      ,
      pendingMessageCount: snapshot.pendingMessageCount
    };
  }

  return {
    kind: "idle",
    label: "空闲"
  };
}

function collectActiveToolNames(transcript: InternalTranscriptItem[]): string[] {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    if (item.kind === "assistant_tool_call") {
      return item.toolCalls
        .map((toolCall) => toolCall.function.name)
        .filter((name, currentIndex, list) => name && list.indexOf(name) === currentIndex);
    }
    if (item.kind === "tool_result" || item.kind === "user_message" || item.kind === "assistant_message") {
      return [];
    }
  }
  return [];
}

function summarizePreviewText(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 60)}...`;
}

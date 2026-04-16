import type { InternalTranscriptItem, SessionPhase } from "#conversation/session/sessionTypes.ts";
import type { ParsedWebSessionStreamQuery } from "../routeSupport.ts";

export type WebSessionPhase = SessionPhase & { label: string };

export type WebSessionStreamEvent =
  | {
      type: "ready";
      sessionId: string;
      modeId: string;
      mutationEpoch: number;
      transcriptCount: number;
      lastActiveAt: number;
      phase: WebSessionPhase;
      timestampMs: number;
    }
  | {
      type: "reset";
      sessionId: string;
      modeId: string;
      mutationEpoch: number;
      transcriptCount: number;
      lastActiveAt: number;
      phase: WebSessionPhase;
      reason: "mutation_epoch_changed" | "transcript_cursor_ahead" | "transcript_gap_detected";
      timestampMs: number;
    }
  | {
      type: "status";
      sessionId: string;
      modeId: string;
      mutationEpoch: number;
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
    }
  | {
      type: "session_error";
      message: string;
    };

export type WebSessionStreamSnapshot = {
  sessionId: string;
  modeId: string;
  mutationEpoch: number;
  transcript: InternalTranscriptItem[];
  lastActiveAt: number;
  phase: SessionPhase;
  activeAssistantResponseText: string | null;
};

export function buildInitialSessionStreamEvents(
  snapshot: WebSessionStreamSnapshot,
  query: ParsedWebSessionStreamQuery
): WebSessionStreamEvent[] {
  const readyEvent: WebSessionStreamEvent = {
    type: "ready",
    sessionId: snapshot.sessionId,
    modeId: snapshot.modeId,
    mutationEpoch: snapshot.mutationEpoch,
    transcriptCount: snapshot.transcript.length,
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
      modeId: snapshot.modeId,
      mutationEpoch: snapshot.mutationEpoch,
      transcriptCount: snapshot.transcript.length,
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
      modeId: snapshot.modeId,
      mutationEpoch: snapshot.mutationEpoch,
      transcriptCount: snapshot.transcript.length,
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
      modeId: current.modeId,
      mutationEpoch: current.mutationEpoch,
      transcriptCount: current.transcript.length,
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
      modeId: current.modeId,
      mutationEpoch: current.mutationEpoch,
      transcriptCount: current.transcript.length,
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

  const previousPhase = deriveWebSessionPhase(previous);
  const currentPhase = deriveWebSessionPhase(current);

  if (
    current.lastActiveAt !== previous.lastActiveAt
    || current.modeId !== previous.modeId
    || currentPhase.label !== previousPhase.label
    || currentPhase.kind !== previousPhase.kind
  ) {
    events.push({
      type: "status",
      sessionId: current.sessionId,
      modeId: current.modeId,
      mutationEpoch: current.mutationEpoch,
      lastActiveAt: current.lastActiveAt,
      phase: currentPhase,
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
  const phase = snapshot.phase;

  switch (phase.kind) {
    case "idle":
      return { ...phase, label: "空闲" };
    case "debouncing":
      return { ...phase, label: "等待接收消息" };
    case "turn_planner_evaluating":
      return { ...phase, label: "正在分析上下文" };
    case "turn_planner_waiting":
      return { ...phase, label: "暂不回复，等待触发" };
    case "requesting_llm":
      return { ...phase, label: "正在发起请求" };
    case "reasoning":
      return { ...phase, label: "正在思考" };
    case "generating":
      return { ...phase, label: "正在生成回复" };
    case "tool_calling":
      return { ...phase, label: `正在调用工具：${phase.toolNames.join("、")}` };
    case "delivering":
      return { ...phase, label: "正在输出回复", ...(snapshot.activeAssistantResponseText ? { previewText: summarizePreviewText(snapshot.activeAssistantResponseText) } : {}) };
  }
}

function summarizePreviewText(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 60)}...`;
}

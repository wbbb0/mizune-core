import type { InternalTranscriptItem, SessionPhase } from "#conversation/session/sessionTypes.ts";
import type { ParsedWebSessionStreamQuery } from "../routeSupport.ts";
import { buildTranscriptItemPatch, getTranscriptItemId } from "#conversation/session/transcriptMetadata.ts";
import type { TranscriptItemPatch } from "#conversation/session/transcriptContract.ts";

export type WebSessionPhase =
  | (Exclude<SessionPhase, { kind: "delivering" }> & { label: string })
  | (Extract<SessionPhase, { kind: "delivering" }> & { label: string; previewText?: string | null });
export type WebSessionStatusPatch = {
  modeId?: string;
  lastActiveAt?: number;
  phase?: WebSessionPhase;
};

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
      type: "status_patch";
      sessionId: string;
      mutationEpoch: number;
      patch: WebSessionStatusPatch;
      timestampMs: number;
    }
  | {
      type: "transcript_item_added";
      sessionId: string;
      mutationEpoch: number;
      index: number;
      totalCount: number;
      item: InternalTranscriptItem;
      timestampMs: number;
    }
  | {
      type: "transcript_item_patched";
      sessionId: string;
      mutationEpoch: number;
      itemId: string;
      patch: TranscriptItemPatch;
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

  if (hasTranscriptIndexGap(previous, current)) {
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
  events.push(...buildTranscriptPatchEvents(previous, current));

  const previousPhase = deriveWebSessionPhase(previous);
  const currentPhase = deriveWebSessionPhase(current);

  if (
    current.lastActiveAt !== previous.lastActiveAt
    || current.modeId !== previous.modeId
    || !isSameWebSessionPhase(previousPhase, currentPhase)
  ) {
    const patch: WebSessionStatusPatch = {};
    if (current.modeId !== previous.modeId) {
      patch.modeId = current.modeId;
    }
    if (current.lastActiveAt !== previous.lastActiveAt) {
      patch.lastActiveAt = current.lastActiveAt;
    }
    if (!isSameWebSessionPhase(previousPhase, currentPhase)) {
      patch.phase = currentPhase;
    }
    events.push({
      type: "status_patch",
      sessionId: current.sessionId,
      mutationEpoch: current.mutationEpoch,
      patch,
      timestampMs: Date.now()
    });
  }

  return events;
}

function hasTranscriptIndexGap(
  previous: WebSessionStreamSnapshot,
  current: WebSessionStreamSnapshot
): boolean {
  const comparableLength = Math.min(previous.transcript.length, current.transcript.length);

  for (let index = 0; index < comparableLength; index += 1) {
    const previousItem = previous.transcript[index];
    const currentItem = current.transcript[index];
    if (!previousItem || !currentItem) {
      continue;
    }
    if (getTranscriptItemId(previousItem) !== getTranscriptItemId(currentItem)) {
      return true;
    }
  }

  return false;
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
      type: "transcript_item_added",
      sessionId: snapshot.sessionId,
      mutationEpoch: snapshot.mutationEpoch,
      index,
      totalCount: snapshot.transcript.length,
      item,
      timestampMs: Date.now()
    });
  }

  return events;
}

function buildTranscriptPatchEvents(
  previous: WebSessionStreamSnapshot,
  current: WebSessionStreamSnapshot
): WebSessionStreamEvent[] {
  const events: WebSessionStreamEvent[] = [];
  const comparableLength = Math.min(previous.transcript.length, current.transcript.length);

  for (let index = 0; index < comparableLength; index += 1) {
    const previousItem = previous.transcript[index];
    const currentItem = current.transcript[index];
    if (!previousItem || !currentItem) {
      continue;
    }
    const previousId = getTranscriptItemId(previousItem);
    const currentId = getTranscriptItemId(currentItem);
    if (previousId !== currentId) {
      continue;
    }
    const patch = buildTranscriptItemPatch(previousItem, currentItem);
    if (!patch) {
      continue;
    }
    events.push({
      type: "transcript_item_patched",
      sessionId: current.sessionId,
      mutationEpoch: current.mutationEpoch,
      itemId: currentId,
      patch,
      timestampMs: Date.now()
    });
  }

  return events;
}

function isSameWebSessionPhase(previous: WebSessionPhase, current: WebSessionPhase): boolean {
  if (previous.kind !== current.kind || previous.label !== current.label) {
    return false;
  }
  if (previous.kind === "tool_calling" && current.kind === "tool_calling") {
    return (
      previous.lastToolName === current.lastToolName
      && previous.toolNames.length === current.toolNames.length
      && previous.toolNames.every((toolName, index) => toolName === current.toolNames[index])
    );
  }
  if (previous.kind === "delivering" && current.kind === "delivering") {
    return previous.previewText === current.previewText;
  }
  return true;
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

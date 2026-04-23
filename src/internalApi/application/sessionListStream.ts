import type { InternalApiSessionSummary } from "../types.ts";

export type SessionListStreamEvent =
  | {
      type: "ready";
      sessions: InternalApiSessionSummary[];
      timestampMs: number;
    }
  | {
      type: "session_upsert";
      session: InternalApiSessionSummary;
      timestampMs: number;
    }
  | {
      type: "session_removed";
      sessionId: string;
      timestampMs: number;
    };

function compareSessionSummary(left: InternalApiSessionSummary, right: InternalApiSessionSummary): number {
  if (right.lastActiveAt !== left.lastActiveAt) {
    return right.lastActiveAt - left.lastActiveAt;
  }
  return left.id.localeCompare(right.id);
}

function sortSessions(sessions: InternalApiSessionSummary[]): InternalApiSessionSummary[] {
  return [...sessions].sort(compareSessionSummary);
}

function isSameSessionSummary(
  previous: InternalApiSessionSummary | undefined,
  current: InternalApiSessionSummary
): boolean {
  if (!previous) {
    return false;
  }

  return (
    previous.id === current.id
    && previous.type === current.type
    && previous.source === current.source
    && previous.modeId === current.modeId
    && previous.participantRef.kind === current.participantRef.kind
    && previous.participantRef.id === current.participantRef.id
    && previous.title === current.title
    && previous.titleSource === current.titleSource
    && previous.isGenerating === current.isGenerating
    && previous.lastActiveAt === current.lastActiveAt
  );
}

export function buildInitialSessionListStreamEvents(
  sessions: InternalApiSessionSummary[]
): SessionListStreamEvent[] {
  return [{
    type: "ready",
    sessions: sortSessions(sessions),
    timestampMs: Date.now()
  }];
}

export function diffSessionListStreamEvents(
  previous: InternalApiSessionSummary[],
  current: InternalApiSessionSummary[]
): SessionListStreamEvent[] {
  const events: SessionListStreamEvent[] = [];
  const previousById = new Map(previous.map((session) => [session.id, session]));
  const currentById = new Map(current.map((session) => [session.id, session]));

  for (const session of sortSessions(current)) {
    if (!isSameSessionSummary(previousById.get(session.id), session)) {
      events.push({
        type: "session_upsert",
        session,
        timestampMs: Date.now()
      });
    }
  }

  for (const session of previous) {
    if (!currentById.has(session.id)) {
      events.push({
        type: "session_removed",
        sessionId: session.id,
        timestampMs: Date.now()
      });
    }
  }

  return events;
}

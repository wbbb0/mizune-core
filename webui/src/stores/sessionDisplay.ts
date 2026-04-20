import type { SessionListItem, SessionTitleSource } from "../api/types.js";

export type NormalizedSessionListItem = SessionListItem & {
  participantLabel: string | null;
};

function resolveParticipantEntryLabel(session: Pick<SessionListItem, "participantRef" | "participantUserId" | "id">): string | null {
  return session.participantRef.kind === "group"
    ? `群 ${session.participantRef.id}`
    : session.participantRef.id || session.participantUserId || session.id;
}

export function resolveSessionDisplayLabel(session: Pick<SessionListItem, "source" | "title" | "participantRef" | "participantUserId" | "id">): string | null {
  if (session.source === "web") {
    const title = String(session.title ?? "").trim();
    if (title) {
      return title;
    }
  }
  return resolveParticipantEntryLabel(session);
}

export function normalizeSessionListItem(session: SessionListItem): NormalizedSessionListItem {
  return {
    ...session,
    participantLabel: resolveSessionDisplayLabel(session)
  };
}

export function syncSessionDisplayFields<T extends {
  type: SessionListItem["type"];
  source: SessionListItem["source"];
  modeId: string;
  participantUserId: string;
  participantRef: SessionListItem["participantRef"];
  title: string | null;
  titleSource: SessionTitleSource | null;
  participantLabel?: string | null;
  lastActiveAt: number;
}>(current: T, next: NormalizedSessionListItem): T {
  return {
    ...current,
    type: next.type,
    source: next.source,
    modeId: next.modeId,
    participantUserId: next.participantUserId,
    participantRef: next.participantRef,
    title: next.title,
    titleSource: next.titleSource,
    participantLabel: next.participantLabel,
    lastActiveAt: next.lastActiveAt
  };
}

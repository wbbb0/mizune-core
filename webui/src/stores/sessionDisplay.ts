import type { SessionListItem, SessionTitleSource } from "../api/types.js";

export type NormalizedSessionListItem = SessionListItem & {
  displayLabel: string | null;
};

function resolveParticipantEntryLabel(session: Pick<SessionListItem, "participantRef" | "id">): string | null {
  return session.participantRef.kind === "group"
    ? `群 ${session.participantRef.id}`
    : session.participantRef.id || session.id;
}

export function resolveSessionDisplayLabel(session: Pick<SessionListItem, "source" | "title" | "participantRef" | "id">): string | null {
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
    displayLabel: resolveSessionDisplayLabel(session)
  };
}

export function sortSessionListItems(left: NormalizedSessionListItem, right: NormalizedSessionListItem): number {
  if (right.lastActiveAt !== left.lastActiveAt) {
    return right.lastActiveAt - left.lastActiveAt;
  }
  return left.id.localeCompare(right.id);
}

export function syncSessionDisplayFields<T extends {
  type: SessionListItem["type"];
  source: SessionListItem["source"];
  modeId: string;
  participantRef: SessionListItem["participantRef"];
  title: string | null;
  titleSource: SessionTitleSource | null;
  displayLabel?: string | null;
  lastActiveAt: number;
}>(current: T, next: NormalizedSessionListItem): T {
  return {
    ...current,
    type: next.type,
    source: next.source,
    modeId: next.modeId,
    participantRef: next.participantRef,
    title: next.title,
    titleSource: next.titleSource,
    displayLabel: next.displayLabel,
    lastActiveAt: next.lastActiveAt
  };
}

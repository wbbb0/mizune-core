import type { SessionState } from "./sessionTypes.ts";

export function resolveDefaultSessionTitle(modeId: string): string {
  return modeId === "scenario_host" ? "New Scenario" : "New Chat";
}

export function resolveSessionDefaultTitle(input: {
  source: SessionState["source"];
  type: SessionState["type"];
  id: string;
  modeId: string;
  participantRef: SessionState["participantRef"];
}): string {
  if (input.source === "web") {
    return resolveDefaultSessionTitle(input.modeId);
  }

  const normalizedId = String(input.participantRef?.id ?? input.id).trim() || input.id;
  const kindLabel = input.type === "group" ? "群" : "私聊";
  return `${input.source}.${kindLabel}.${normalizedId}`;
}

export function resolveSessionDisplayTitle(
  input: Pick<SessionState, "source" | "title" | "type" | "participantRef" | "id">
): string {
  const normalizedTitle = String(input.title ?? "").trim();
  if (normalizedTitle) {
    return normalizedTitle;
  }

  const participantRef = input.participantRef ?? {
    kind: input.type === "group" ? "group" : "user",
    id: String(input.id).trim() || input.id
  };
  return participantRef.kind === "group"
    ? `群 ${participantRef.id}`
    : participantRef.id;
}

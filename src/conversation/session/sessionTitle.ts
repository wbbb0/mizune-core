import type { SessionState } from "./sessionTypes.ts";

export function resolveDefaultSessionTitle(modeId: string): string {
  return modeId === "scenario_host" ? "New Scenario" : "New Chat";
}

export function resolveSessionDisplayTitle(
  input: Pick<SessionState, "source" | "title" | "type" | "participantRef" | "id">
): string {
  const normalizedTitle = String(input.title ?? "").trim();
  if (input.source === "web" && normalizedTitle) {
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

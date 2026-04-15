import { rpAssistantModeDefinition } from "./rpAssistantMode.ts";
import { scenarioHostModeDefinition } from "./scenarioHost/mode.ts";
import type { SessionModeDefinition } from "./types.ts";

const SESSION_MODES: SessionModeDefinition[] = [
  rpAssistantModeDefinition,
  scenarioHostModeDefinition
];

const SESSION_MODE_BY_ID = new Map(SESSION_MODES.map((mode) => [mode.id, mode]));

export function getDefaultSessionModeId(): string {
  return rpAssistantModeDefinition.id;
}

export function listSessionModes(): SessionModeDefinition[] {
  return [...SESSION_MODES];
}

export function getSessionModeDefinition(modeId: string): SessionModeDefinition | null {
  return SESSION_MODE_BY_ID.get(modeId) ?? null;
}

export function requireSessionModeDefinition(modeId: string): SessionModeDefinition {
  const mode = getSessionModeDefinition(modeId);
  if (!mode) {
    throw new Error(`Unsupported session mode: ${modeId}`);
  }
  return mode;
}

export function sessionModeSupportsChatType(modeId: string, chatType: "private" | "group"): boolean {
  return requireSessionModeDefinition(modeId).allowedChatTypes.includes(chatType);
}

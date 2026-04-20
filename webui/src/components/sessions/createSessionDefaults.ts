export const CREATE_SESSION_MODE_STORAGE_KEY = "llm-onebot:create-session-mode-id";
export const DEFAULT_CREATE_SESSION_MODE_ID = "rp_assistant";

export function resolveCreateSessionModeId(input: {
  storedModeId?: string | null;
  availableModeIds: string[];
  fallbackModeId?: string;
}): string {
  const fallbackModeId = input.fallbackModeId ?? DEFAULT_CREATE_SESSION_MODE_ID;
  const availableModeIds = input.availableModeIds.filter((modeId) => Boolean(modeId.trim()));

  const storedModeId = String(input.storedModeId ?? "").trim();
  if (storedModeId && availableModeIds.includes(storedModeId)) {
    return storedModeId;
  }

  if (availableModeIds.includes(fallbackModeId)) {
    return fallbackModeId;
  }

  return availableModeIds[0] ?? fallbackModeId;
}

export function resolveCreateSessionTitlePlaceholder(modeId: string): string {
  return modeId === "scenario_host" ? "New Scenario" : "New Chat";
}

export function readStoredCreateSessionModeId(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(CREATE_SESSION_MODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredCreateSessionModeId(storage: Pick<Storage, "setItem"> | null | undefined, modeId: string): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(CREATE_SESSION_MODE_STORAGE_KEY, modeId);
  } catch {
    // Ignore storage errors; the dialog still works without persisted memory.
  }
}

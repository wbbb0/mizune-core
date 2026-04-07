import type { Logger } from "pino";
import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { UserStore } from "#identity/userStore.ts";

export interface SessionWorkPersistenceDeps {
  logger: Logger;
  sessionManager: SessionManager;
  userStore: UserStore;
  persistSession: (sessionId: string, reason: string) => void;
}
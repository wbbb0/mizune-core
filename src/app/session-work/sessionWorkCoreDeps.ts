import type { Logger } from "pino";
import type { SessionInternalTriggerDispatchAccess } from "#conversation/session/sessionCapabilities.ts";
import type { UserStore } from "#identity/userStore.ts";

export interface SessionWorkPersistenceDeps {
  logger: Logger;
  sessionManager: SessionInternalTriggerDispatchAccess;
  userStore: UserStore;
  persistSession: (sessionId: string, reason: string) => void;
}

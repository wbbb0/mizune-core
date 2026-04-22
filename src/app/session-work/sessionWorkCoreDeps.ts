import type { Logger } from "pino";
import type { SessionInternalTriggerDispatchAccess } from "#conversation/session/sessionCapabilities.ts";
import type { UserIdentityStore } from "#identity/userIdentityStore.ts";
import type { UserStore } from "#identity/userStore.ts";

export interface SessionWorkPersistenceDeps {
  logger: Logger;
  sessionManager: SessionInternalTriggerDispatchAccess;
  userStore: UserStore;
  userIdentityStore: UserIdentityStore;
  persistSession: (sessionId: string, reason: string) => void;
}

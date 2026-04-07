import type { InternalApiDeps } from "../types.ts";

export function getHealthStatus() {
  return { ok: true };
}

export function getConfigSummary(deps: Pick<InternalApiDeps, "config" | "whitelistStore">) {
  const whitelist = deps.whitelistStore.getSnapshot();
  return {
    onebot: {
      wsUrl: deps.config.onebot.wsUrl,
      httpUrl: deps.config.onebot.httpUrl
    },
    ownerId: whitelist.ownerId ?? null,
    whitelist: {
      enabled: deps.config.whitelist.enabled,
      users: whitelist.users,
      groups: whitelist.groups
    }
  };
}

export async function listUsers(deps: Pick<InternalApiDeps, "userStore">) {
  return {
    users: await deps.userStore.list()
  };
}

export function listSessions(deps: Pick<InternalApiDeps, "sessionManager">) {
  return {
    sessions: deps.sessionManager.listSessions().map((session) => ({
      id: session.id,
      type: session.type,
      pendingMessageCount: session.pendingMessages.length,
      isGenerating: session.isGenerating,
      lastActiveAt: session.lastActiveAt
    }))
  };
}

export async function getSessionDetail(
  deps: Pick<InternalApiDeps, "sessionManager">,
  sessionId: string
) {
  const existing = deps.sessionManager.listSessions().find((item) => item.id === sessionId);
  if (!existing) {
    return null;
  }

  return {
    session: {
      ...deps.sessionManager.getSessionView(sessionId),
      isGenerating: existing.isGenerating,
      pendingMessageCount: existing.pendingMessages.length,
      historyRevision: deps.sessionManager.getHistoryRevision(sessionId),
      mutationEpoch: deps.sessionManager.getMutationEpoch(sessionId)
    }
  };
}

export async function getPersona(deps: Pick<InternalApiDeps, "personaStore">) {
  return {
    persona: await deps.personaStore.get()
  };
}

export function getWhitelist(deps: Pick<InternalApiDeps, "whitelistStore">) {
  return {
    whitelist: deps.whitelistStore.getSnapshot()
  };
}

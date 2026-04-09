import type { InternalApiDeps } from "../types.ts";
import type { ParsedCreateSessionBody } from "../routeSupport.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";

import { isSessionGenerating } from "#conversation/session/sessionQueries.ts";

function buildSessionSummary(session: SessionState) {
  return {
    id: session.id,
    type: session.type,
    source: session.source,
    participantUserId: session.participantUserId,
    participantLabel: session.participantLabel,
    isGenerating: isSessionGenerating(session),
    lastActiveAt: session.lastActiveAt
  };
}

export function getHealthStatus() {
  return { ok: true };
}

export function getConfigSummary(deps: Pick<InternalApiDeps, "config" | "whitelistStore">) {
  const whitelist = deps.whitelistStore.getSnapshot();
  const runtimeMode = deps.config.onebot.enabled ? "onebot" : "webui_only";
  return {
    runtimeMode,
    onebot: {
      enabled: deps.config.onebot.enabled,
      wsUrl: deps.config.onebot.wsUrl,
      httpUrl: deps.config.onebot.httpUrl
    },
    access: {
      ownerId: deps.config.onebot.enabled ? (whitelist.ownerId ?? null) : null,
      whitelist: {
        enabled: deps.config.onebot.enabled ? deps.config.whitelist.enabled : false,
        users: deps.config.onebot.enabled ? whitelist.users : [],
        groups: deps.config.onebot.enabled ? whitelist.groups : []
      }
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
    sessions: deps.sessionManager.listSessions().map((session) => buildSessionSummary(session))
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
      isGenerating: isSessionGenerating(existing),
      historyRevision: deps.sessionManager.getHistoryRevision(sessionId),
      mutationEpoch: deps.sessionManager.getMutationEpoch(sessionId)
    }
  };
}

export function createWebSession(
  deps: Pick<InternalApiDeps, "sessionManager" | "sessionPersistence">,
  body: ParsedCreateSessionBody
) {
  const sessionId = createWebSessionId();
  const session = deps.sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "web",
    participantUserId: body.participantUserId,
    participantLabel: body.participantLabel ?? body.participantUserId
  });
  void deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(session.id));
  return {
    ok: true,
    session: buildSessionSummary(session)
  };
}

export async function deleteSession(
  deps: Pick<InternalApiDeps, "sessionManager" | "sessionPersistence">,
  sessionId: string
) {
  const deleted = deps.sessionManager.deleteSession(sessionId);
  if (!deleted) {
    return { ok: false as const };
  }
  await deps.sessionPersistence.remove(sessionId);
  return { ok: true as const };
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

function createWebSessionId(): string {
  return `web:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

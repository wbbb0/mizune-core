import type {
  InternalApiConfigSummaryDeps,
  InternalApiPersonaDeps,
  InternalApiSessionDeleteDeps,
  InternalApiSessionReadDeps,
  InternalApiSessionWriteDeps,
  InternalApiUserDeps,
  InternalApiWhitelistDeps
} from "../types.ts";
import type {
  ParsedCreateSessionBody,
  ParsedSwitchSessionModeBody,
  ParsedUpdateSessionModeStateBody
} from "../routeSupport.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";
import { getDefaultSessionModeId, listSessionModes, requireSessionModeDefinition, sessionModeSupportsChatType } from "#modes/registry.ts";
import { resolveSessionParticipantLabel } from "#conversation/session/sessionIdentity.ts";
import { scenarioHostSessionStateSchema, type ScenarioHostSessionState } from "#modes/scenarioHost/types.ts";

import { isSessionGenerating } from "#conversation/session/sessionQueries.ts";

function buildSessionSummary(session: SessionState) {
  return {
    id: session.id,
    type: session.type,
    source: session.source,
    modeId: session.modeId,
    participantUserId: session.participantUserId,
    participantLabel: resolveSessionParticipantLabel({
      sessionId: session.id,
      participantLabel: session.participantLabel,
      participantUserId: session.participantUserId,
      type: session.type
    }),
    isGenerating: isSessionGenerating(session),
    lastActiveAt: session.lastActiveAt
  };
}

export function getHealthStatus() {
  return { ok: true };
}

export function getConfigSummary(deps: InternalApiConfigSummaryDeps) {
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

export async function listUsers(deps: InternalApiUserDeps) {
  return {
    users: await deps.userStore.list()
  };
}

export function listSessions(deps: InternalApiSessionReadDeps) {
  return {
    sessions: deps.sessionManager.listSessions().map((session) => buildSessionSummary(session))
  };
}

export function listAvailableSessionModes() {
  return {
    modes: listSessionModes().map((mode) => ({
      id: mode.id,
      title: mode.title,
      description: mode.description,
      allowedChatTypes: mode.allowedChatTypes
    }))
  };
}

function assertSessionModeAllowed(modeId: string, chatType: "private" | "group"): void {
  if (!sessionModeSupportsChatType(modeId, chatType)) {
    throw new Error(`Session mode ${modeId} does not support ${chatType} chat`);
  }
}

export async function getSessionDetail(
  deps: InternalApiSessionReadDeps,
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
    },
    modeState: await getSessionModeStateDetail(deps, existing)
  };
}

async function getSessionModeStateDetail(
  deps: InternalApiSessionReadDeps,
  session: SessionState
): Promise<{ kind: "scenario_host"; state: ScenarioHostSessionState } | null> {
  if (session.modeId !== "scenario_host") {
    return null;
  }

  const state = await deps.scenarioHostStateStore.ensureForSession(session);
  return {
    kind: "scenario_host",
    state
  };
}

export async function createWebSession(
  deps: InternalApiSessionWriteDeps,
  body: ParsedCreateSessionBody
) {
  const sessionId = createWebSessionId();
  const modeId = body.modeId ?? getDefaultSessionModeId();
  requireSessionModeDefinition(modeId);
  assertSessionModeAllowed(modeId, "private");
  const session = deps.sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "web",
    participantUserId: body.participantUserId,
    participantLabel: resolveSessionParticipantLabel({
      sessionId,
      participantLabel: body.participantLabel,
      participantUserId: body.participantUserId,
      type: "private"
    })
  });
  deps.sessionManager.setModeId(session.id, modeId, { appendSwitchMarker: false });
  if (modeId === "scenario_host") {
    await deps.scenarioHostStateStore.ensureForSession(deps.sessionManager.getSession(session.id));
  }
  await deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(session.id));
  return {
    ok: true,
    session: buildSessionSummary(session)
  };
}

export async function switchSessionMode(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  body: ParsedSwitchSessionModeBody
) {
  requireSessionModeDefinition(body.modeId);
  const session = deps.sessionManager.getSession(sessionId);
  assertSessionModeAllowed(body.modeId, session.type);
  deps.sessionManager.setModeId(sessionId, body.modeId);
  if (body.modeId === "scenario_host") {
    await deps.scenarioHostStateStore.ensureForSession(session);
  }
  await deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(sessionId));
  return {
    ok: true as const,
    session: buildSessionSummary(deps.sessionManager.getSession(sessionId))
  };
}

export async function updateSessionModeState(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  body: ParsedUpdateSessionModeStateBody
) {
  const session = deps.sessionManager.getSession(sessionId);
  if (session.modeId !== "scenario_host") {
    throw new Error(`Session mode ${session.modeId} does not support editable mode state; only scenario_host is supported`);
  }

  const state = await deps.scenarioHostStateStore.write(
    sessionId,
    scenarioHostSessionStateSchema.parse(body.state)
  );

  return {
    ok: true as const,
    modeState: {
      kind: "scenario_host" as const,
      state
    }
  };
}

export async function deleteSession(
  deps: InternalApiSessionDeleteDeps,
  sessionId: string
) {
  const deleted = deps.sessionManager.deleteSession(sessionId);
  if (!deleted) {
    return { ok: false as const };
  }
  await deps.sessionPersistence.remove(sessionId);
  await deps.chatMessageFileGcService.sweep({
    activeSessions: deps.sessionManager.listSessions(),
    persistedSessions: await deps.sessionPersistence.loadAll()
  });
  return { ok: true as const };
}

export async function getPersona(deps: InternalApiPersonaDeps) {
  return {
    persona: await deps.personaStore.get()
  };
}

export function getWhitelist(deps: InternalApiWhitelistDeps) {
  return {
    whitelist: deps.whitelistStore.getSnapshot()
  };
}

function createWebSessionId(): string {
  return `web:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

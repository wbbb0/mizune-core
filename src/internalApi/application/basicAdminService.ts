import type {
  InternalApiConfigSummaryDeps,
  InternalApiPersonaDeps,
  InternalApiSessionDetail,
  InternalApiSessionDeleteDeps,
  InternalApiSessionReadDeps,
  InternalApiSessionSummary,
  InternalApiSessionWriteDeps,
  InternalApiUserDeps,
  InternalApiWhitelistDeps
} from "../types.ts";
import type {
  ParsedCreateSessionBody,
  ParsedSwitchSessionModeBody,
  ParsedUpdateSessionModeStateBody,
  ParsedUpdateSessionTitleBody
} from "../routeSupport.ts";
import type { SessionParticipantRef, SessionState } from "#conversation/session/sessionTypes.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import { getDefaultSessionModeId, listSessionModes, requireSessionModeDefinition, sessionModeSupportsChatType } from "#modes/registry.ts";
import { scenarioHostSessionStateSchema, type ScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
import { createSessionTitleGenerationEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { DerivedObservationReader } from "#llm/derivations/derivedObservationReader.ts";
import { isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";
import {
  buildInitialSessionListStreamEvents,
  diffSessionListStreamEvents,
  type SessionListStreamEvent
} from "./sessionListStream.ts";

import { isSessionGenerating } from "#conversation/session/sessionQueries.ts";
import { resolveDefaultSessionTitle } from "#conversation/session/sessionTitle.ts";

function toScenarioHostSession(session: SessionState): Pick<SessionState, "id" | "participantRef"> {
  return {
    id: session.id,
    participantRef: session.participantRef
  };
}

function buildSessionSummary(session: SessionState): InternalApiSessionSummary {
  return {
    id: session.id,
    type: session.type,
    source: session.source,
    modeId: session.modeId,
    participantRef: session.participantRef,
    title: session.title,
    titleSource: session.titleSource,
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
  const ownerIdentity = deps.userIdentityStore.findIdentityByInternalUserIdSync("owner");
  return {
    runtimeMode,
    onebot: {
      enabled: deps.config.onebot.enabled,
      wsUrl: deps.config.onebot.wsUrl,
      httpUrl: deps.config.onebot.httpUrl
    },
    access: {
      ownerId: deps.config.onebot.enabled ? (ownerIdentity?.externalId ?? null) : null,
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

export function getSessionListStream(deps: InternalApiSessionReadDeps): {
  initialEvents: SessionListStreamEvent[];
  subscribe: (listener: (event: SessionListStreamEvent) => void) => () => void;
} {
  let previousSessions = deps.sessionManager.listSessions().map((session) => buildSessionSummary(session));

  return {
    initialEvents: buildInitialSessionListStreamEvents(previousSessions),
    subscribe(listener) {
      return deps.sessionManager.subscribeSessions(() => {
        const currentSessions = deps.sessionManager.listSessions().map((session) => buildSessionSummary(session));
        for (const event of diffSessionListStreamEvents(previousSessions, currentSessions)) {
          listener(event);
        }
        previousSessions = currentSessions;
      });
    }
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
): Promise<InternalApiSessionDetail | null> {
  const existing = deps.sessionManager.listSessions().find((item) => item.id === sessionId);
  if (!existing) {
    return null;
  }

  const {
    participantLabel: _participantLabel,
    participantUserId: _participantUserId,
    ...sessionView
  } = deps.sessionManager.getSessionView(sessionId);
  const mediaIds = collectDerivedObservationMediaIds(sessionView.internalTranscript);
  const derivedObservationReader = new DerivedObservationReader({
    chatFileStore: deps.chatFileStore,
    audioStore: deps.audioStore
  });
  return {
    session: {
      ...sessionView,
      participantRef: existing.participantRef,
      title: existing.title,
      titleSource: existing.titleSource,
      titleGenerationAvailable: existing.source === "web" && deps.sessionCaptioner.isAvailable(),
      derivedObservations: await derivedObservationReader.read({
        sessions: [existing],
        chatFileIds: mediaIds.chatFileIds,
        audioIds: mediaIds.audioIds
      }),
      contentSafetyAudits: await deps.contentSafetyStore?.listBySessionId(sessionId) ?? [],
      isGenerating: isSessionGenerating(existing),
      historyRevision: deps.sessionManager.getHistoryRevision(sessionId),
      mutationEpoch: deps.sessionManager.getMutationEpoch(sessionId)
    },
    modeState: await getSessionModeStateDetail(deps, existing)
  };
}

function collectDerivedObservationMediaIds(transcript: readonly InternalTranscriptItem[]): {
  chatFileIds: string[];
  audioIds: string[];
} {
  const chatFileIds = new Set<string>();
  const audioIds = new Set<string>();
  for (const item of transcript) {
    if (item.kind === "user_message") {
      for (const imageId of item.imageIds) {
        if (!isPendingChatAttachmentId(imageId)) {
          chatFileIds.add(imageId);
        }
      }
      for (const emojiId of item.emojiIds) {
        if (!isPendingChatAttachmentId(emojiId)) {
          chatFileIds.add(emojiId);
        }
      }
      for (const attachment of item.attachments) {
        if (!isPendingChatAttachmentId(attachment.fileId)) {
          chatFileIds.add(attachment.fileId);
        }
      }
    }
    for (const match of extractMediaIdsFromText(JSON.stringify(item))) {
      if (match.startsWith("file_")) {
        chatFileIds.add(match);
      } else if (match.startsWith("aud_")) {
        audioIds.add(match);
      }
    }
  }
  return {
    chatFileIds: Array.from(chatFileIds),
    audioIds: Array.from(audioIds)
  };
}

function extractMediaIdsFromText(text: string): string[] {
  return Array.from(String(text ?? "").matchAll(/\b(?:file|aud)_[a-zA-Z0-9_:-]+\b/g), (match) => match[0]);
}

async function getSessionModeStateDetail(
  deps: InternalApiSessionReadDeps,
  session: SessionState
): Promise<{ kind: "scenario_host"; state: ScenarioHostSessionState } | null> {
  if (session.modeId !== "scenario_host") {
    return null;
  }

  const state = await deps.scenarioHostStateStore.ensureForSession(toScenarioHostSession(session));
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
  const title = body.title?.trim() || resolveDefaultSessionTitle(modeId);
  const participantRef: SessionParticipantRef = {
    kind: "user",
    id: "owner"
  };
  const session = deps.sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "web",
    participantRef,
    title,
    titleSource: body.title?.trim() ? "manual" : "default"
  });
  deps.sessionManager.setModeId(session.id, modeId, { appendSwitchMarker: false });
  if (modeId === "scenario_host") {
    await deps.scenarioHostStateStore.ensureForSession(toScenarioHostSession(deps.sessionManager.getSession(session.id)));
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
    await deps.scenarioHostStateStore.ensureForSession(toScenarioHostSession(session));
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

export async function updateSessionTitle(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  body: ParsedUpdateSessionTitleBody
) {
  const session = deps.sessionManager.getSession(sessionId);
  if (session.source !== "web") {
    throw new Error("Only web sessions support title editing");
  }
  deps.sessionManager.setTitle(sessionId, body.title, "manual");
  await deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(sessionId));
  return {
    ok: true as const,
    session: buildSessionSummary(deps.sessionManager.getSession(sessionId))
  };
}

export async function regenerateSessionTitle(
  deps: InternalApiSessionWriteDeps,
  sessionId: string
) {
  const session = deps.sessionManager.getSession(sessionId);
  if (session.source !== "web") {
    throw new Error("Only web sessions support title regeneration");
  }
  if (!deps.sessionCaptioner.isAvailable()) {
    throw new Error("标题生成器不可用");
  }

  const generated = await deps.sessionCaptioner.generateTitle({
    sessionId,
    modeId: session.modeId,
    reason: "manual_regenerate",
    historySummary: session.historySummary,
    history: deps.sessionManager.getLlmVisibleHistory(sessionId)
  });
  if (!generated) {
    throw new Error("Failed to generate session title");
  }
  deps.sessionManager.setTitle(sessionId, generated, "auto");
  deps.sessionManager.appendInternalTranscript(sessionId, createSessionTitleGenerationEvent({
    source: "regenerate",
    modeId: session.modeId,
    title: generated,
    summary: generated,
    details: [
      `sessionId: ${sessionId}`,
      `modeId: ${session.modeId}`,
      `historySummary: ${String(session.historySummary ?? "").trim() || "(none)"}`,
      `historyCount: ${deps.sessionManager.getLlmVisibleHistory(sessionId).length}`
    ].join("\n")
  }));
  await deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(sessionId));

  return {
    ok: true as const,
    session: buildSessionSummary(deps.sessionManager.getSession(sessionId))
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

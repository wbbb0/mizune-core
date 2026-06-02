import type {
  InternalApiConfigSummaryDeps,
  InternalApiContextDeps,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
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

export function listContextItems(
  deps: InternalApiContextDeps,
  input: {
    userId?: string;
    scope?: string;
    sourceType?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }
) {
  return deps.contextStore.listContextItems(input);
}

export function getContextStatus(deps: InternalApiContextDeps) {
  return {
    store: deps.contextStore.getStatus(),
    embedding: deps.contextEmbeddingService.getStatus(),
    stats: deps.contextStore.getContextStats(),
    lastRetrieval: deps.contextRetrievalService.getLastDebugReport()
  };
}

export function deleteContextItem(deps: InternalApiContextDeps, itemId: string) {
  return deps.contextStore.deleteContextItem(itemId);
}

export function updateContextItem(
  deps: InternalApiContextDeps,
  input: Parameters<InternalApiContextDeps["contextStore"]["updateContextItem"]>[0]
) {
  return deps.contextStore.updateContextItem(input);
}

export function bulkDeleteContextItems(
  deps: InternalApiContextDeps,
  input: Parameters<InternalApiContextDeps["contextStore"]["bulkDeleteContextItems"]>[0]
) {
  return deps.contextStore.bulkDeleteContextItems(input);
}

export function exportContextItems(
  deps: InternalApiContextDeps,
  input: Parameters<InternalApiContextDeps["contextStore"]["exportContextItemsJsonl"]>[0]
) {
  return deps.contextStore.exportContextItemsJsonl(input);
}

export function importContextItems(deps: InternalApiContextDeps, jsonl: string) {
  return deps.contextStore.importContextItemsJsonl(jsonl);
}

export function setContextItemPinned(deps: InternalApiContextDeps, itemId: string, pinned: boolean) {
  return deps.contextStore.setContextItemPinned(itemId, pinned);
}

export function compactContextUser(deps: InternalApiContextDeps, input: {
  userId: string;
  olderThanMs: number;
  maxSourceChunks?: number;
}) {
  return deps.contextStore.compactUserSearchChunks(input);
}

export function sweepDeletedContextItems(deps: InternalApiContextDeps, input: {
  deletedBeforeMs: number;
}) {
  return deps.contextStore.sweepDeletedItems(input);
}

export function clearContextEmbeddings(
  deps: InternalApiContextDeps,
  input: Parameters<InternalApiContextDeps["contextStore"]["clearEmbeddings"]>[0]
) {
  return deps.contextStore.clearEmbeddings(input);
}

export function resetContextIndex(deps: InternalApiContextDeps, input?: { userId?: string }) {
  return deps.contextRetrievalService.resetIndexes(input);
}

export async function rebuildContextIndex(deps: InternalApiContextDeps, input: {
  userId?: string;
  forceReembed?: boolean;
  embeddingBatchSize?: number;
}) {
  return deps.contextRetrievalService.rebuildUserIndexes(input);
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
      contentSafetyAudits: normalizeAdminContentSafetyAudits(
        await deps.contentSafetyStore?.listBySessionId(sessionId) ?? [],
        deps.config?.contentSafety.audit.exposeOriginalInAdminApi ?? true
      ),
      memoryContext: deps.contextRetrievalService?.getLastPromptMemoryReport({ sessionId }) ?? null,
      isGenerating: isSessionGenerating(existing),
      historyRevision: deps.sessionManager.getHistoryRevision(sessionId),
      mutationEpoch: deps.sessionManager.getMutationEpoch(sessionId)
    },
    modeState: await getSessionModeStateDetail(deps, existing)
  };
}

function normalizeAdminContentSafetyAudits<T extends { originalText?: string | undefined }>(
  records: T[],
  exposeOriginal: boolean
): T[] {
  if (exposeOriginal) {
    return records;
  }
  return records.map(({ originalText: _originalText, ...record }) => record as T);
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

  const current = await deps.scenarioHostStateStore.ensureForSession(toScenarioHostSession(session));
  const stateInput = mergeScenarioModeStateInput(current, body.state, body.baseState);
  const state = await deps.scenarioHostStateStore.write(
    sessionId,
    scenarioHostSessionStateSchema.parse(stateInput)
  );

  return {
    ok: true as const,
    modeState: {
      kind: "scenario_host" as const,
      state
    }
  };
}

function mergeScenarioModeStateInput(
  current: ScenarioHostSessionState,
  state: unknown,
  baseState: unknown
): unknown {
  if (!isRecord(state)) {
    return state;
  }
  if (!isRecord(baseState)) {
    return Object.prototype.hasOwnProperty.call(state, "profile")
      ? state
      : { ...state, profile: current.profile };
  }
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(state)) {
    if (key === "version") {
      patch[key] = state[key];
      continue;
    }
    if (JSON.stringify(state[key]) !== JSON.stringify(baseState[key])) {
      patch[key] = state[key];
    }
  }
  if ("loreEntries" in patch && Array.isArray(state.loreEntries) && Array.isArray(baseState.loreEntries)) {
    patch.loreEntries = mergeCollectionByKey(
      current.loreEntries,
      baseState.loreEntries as unknown[],
      state.loreEntries as unknown[],
      (item) => isRecord(item) ? String(item.id ?? "") : ""
    );
  }
  if ("entities" in patch && Array.isArray(state.entities) && Array.isArray(baseState.entities)) {
    patch.entities = mergeCollectionByKey(
      current.entities,
      baseState.entities as unknown[],
      state.entities as unknown[],
      (item) => isRecord(item) ? String(item.id ?? "") : ""
    );
  }
  if ("objectives" in patch && Array.isArray(state.objectives) && Array.isArray(baseState.objectives)) {
    patch.objectives = mergeCollectionByKey(
      current.objectives,
      baseState.objectives as unknown[],
      state.objectives as unknown[],
      (item) => isRecord(item) ? String(item.id ?? "") : ""
    );
  }
  if ("inventory" in patch && Array.isArray(state.inventory) && Array.isArray(baseState.inventory)) {
    patch.inventory = mergeCollectionByKey(
      current.inventory,
      baseState.inventory as unknown[],
      state.inventory as unknown[],
      inventoryKey
    );
  }
  if ("relations" in patch && Array.isArray(state.relations) && Array.isArray(baseState.relations)) {
    patch.relations = mergeCollectionByKey(
      current.relations,
      baseState.relations as unknown[],
      state.relations as unknown[],
      relationKey
    );
  }
  if ("journal" in patch && Array.isArray(state.journal) && Array.isArray(baseState.journal)) {
    patch.journal = mergeCollectionByKey(
      current.journal,
      baseState.journal as unknown[],
      state.journal as unknown[],
      (item) => isRecord(item) ? String(item.id ?? "") : ""
    );
  }
  return {
    ...current,
    ...patch,
    version: state.version ?? current.version
  };
}

function mergeCollectionByKey<T>(
  currentItems: T[],
  baseItems: unknown[],
  nextItems: unknown[],
  getKey: (item: unknown) => string
): unknown[] {
  const baseKeys = new Set(baseItems.map(getKey).filter(Boolean));
  const nextKeys = new Set(nextItems.map(getKey).filter(Boolean));
  const changedKeys = new Set<string>();
  for (const item of nextItems) {
    const key = getKey(item);
    if (!key) {
      continue;
    }
    const baseItem = baseItems.find((candidate) => getKey(candidate) === key);
    if (!baseItem || JSON.stringify(baseItem) !== JSON.stringify(item)) {
      changedKeys.add(key);
    }
  }
  for (const key of baseKeys) {
    if (!nextKeys.has(key)) {
      changedKeys.add(key);
    }
  }
  const merged = currentItems
    .filter((item) => {
      const key = getKey(item);
      return !key || !changedKeys.has(key);
    });
  for (const item of nextItems) {
    const key = getKey(item);
    if (key && changedKeys.has(key)) {
      merged.push(item as T);
    }
  }
  return merged;
}

function relationKey(item: unknown): string {
  if (!isRecord(item)) {
    return "";
  }
  return [item.sourceId, item.targetId, item.kind].map((part) => String(part ?? "").trim()).filter(Boolean).join("\u0000");
}

function inventoryKey(item: unknown): string {
  if (!isRecord(item)) {
    return "";
  }
  return [item.ownerId, item.item].map((part) => String(part ?? "").trim()).filter(Boolean).join("\u0000");
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
  deps.contextSessionCleanupService?.cleanupDeletedSession({ sessionId });
  await deps.sessionPersistence.remove(sessionId);
  await deps.assetLifecycleService.onSessionDeleted({
    sessionId,
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

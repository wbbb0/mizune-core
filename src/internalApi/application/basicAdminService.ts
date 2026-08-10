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
  ParsedCopySessionBody,
  ParsedCreateSessionBody,
  ParsedCreateSessionSnapshotBody,
  ParsedSwitchSessionModeBody,
  ParsedUpdateSessionModeStateBody,
  ParsedUpdateSessionPacingBody,
  ParsedUpdateSessionTitleBody
} from "../routeSupport.ts";
import type { PersistedSessionState, SessionParticipantRef, SessionState } from "#conversation/session/sessionTypes.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { SessionSnapshotModeState } from "#conversation/session/sessionSnapshotStore.ts";
import { createNormalSessionOperationMode } from "#conversation/session/sessionOperationMode.ts";
import { createEmptySessionTaskTracker } from "#conversation/taskTracker/taskTrackerTypes.ts";
import { getDefaultSessionModeId, listSessionModes, requireSessionModeDefinition, sessionModeSupportsChatType } from "#modes/registry.ts";
import {
  assertScenarioInitializedStateValid,
  scenarioHostSessionStateSchema,
  type ScenarioHostSessionState
} from "#modes/scenarioHost/types.ts";
import { createSessionTitleGenerationEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { DerivedObservationReader } from "#llm/derivations/derivedObservationReader.ts";
import { isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";
import {
  buildInitialSessionListStreamEvents,
  diffSessionListStreamEvents,
  type SessionListStreamEvent
} from "./sessionListStream.ts";

import { isSessionGenerating, isSessionResponding } from "#conversation/session/sessionQueries.ts";
import { resolveDefaultSessionTitle } from "#conversation/session/sessionTitle.ts";
import { resolveSessionParticipantLabel } from "#conversation/session/sessionIdentity.ts";

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

export async function listSessionSnapshots(
  deps: InternalApiSessionWriteDeps,
  sessionId: string
) {
  const session = findSession(deps, sessionId);
  if (!session) {
    return null;
  }
  return {
    snapshots: await deps.sessionSnapshotStore.list(session.id)
  };
}

export async function createSessionSnapshot(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  body: ParsedCreateSessionSnapshotBody
) {
  const session = findSession(deps, sessionId);
  if (!session) {
    return null;
  }
  assertSessionSnapshotMutationAllowed(session, "存档");
  const modeState = await captureSessionSnapshotModeState(deps, session);
  const snapshot = await deps.sessionSnapshotStore.create({
    sessionId: session.id,
    ...(body.label ? { label: body.label } : {}),
    session: deps.sessionManager.getPersistedSession(session.id),
    modeState
  });
  return {
    ok: true as const,
    snapshot
  };
}

export async function restoreSessionSnapshot(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  snapshotId: string
) {
  const session = findSession(deps, sessionId);
  if (!session) {
    return null;
  }
  assertSessionSnapshotMutationAllowed(session, "读档");
  const snapshot = await deps.sessionSnapshotStore.get(session.id, snapshotId);
  if (!snapshot) {
    return { ok: false as const };
  }
  if (snapshot.payload.session.id !== session.id) {
    throw new Error(`Snapshot ${snapshotId} does not belong to session ${session.id}`);
  }

  const previousSession = deps.sessionManager.getPersistedSession(session.id);
  const previousModeState = await deps.scenarioHostStateStore.get(session.id);
  let restored: SessionState | null = null;
  try {
    await applySessionSnapshotModeState(deps, session.id, snapshot.payload.modeState);
    restored = deps.sessionManager.restorePersistedSession(snapshot.payload.session);
    await deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(restored.id));
  } catch (error: unknown) {
    await restorePreviousSnapshotModeState(deps, session.id, previousModeState).catch(() => undefined);
    if (restored) {
      deps.sessionManager.restorePersistedSession(previousSession);
    }
    throw error;
  }

  return {
    ok: true as const,
    session: buildSessionSummary(restored),
    modeState: await getSessionModeStateDetail(deps, restored),
    snapshot: snapshot.summary
  };
}

export async function deleteSessionSnapshot(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  snapshotId: string
) {
  const session = findSession(deps, sessionId);
  if (!session) {
    return null;
  }
  return {
    ok: await deps.sessionSnapshotStore.delete(session.id, snapshotId)
  };
}

function findSession(deps: InternalApiSessionReadDeps, sessionId: string): SessionState | null {
  return deps.sessionManager.listSessions().find((session) => session.id === sessionId) ?? null;
}

function assertSessionSnapshotMutationAllowed(session: SessionState, action: string): void {
  if (isSessionResponding(session)) {
    throw new Error(`当前会话正在回复，完成后再${action}`);
  }
}

async function captureSessionSnapshotModeState(
  deps: InternalApiSessionWriteDeps,
  session: SessionState
): Promise<SessionSnapshotModeState> {
  if (session.modeId !== "scenario_host") {
    return null;
  }
  return {
    kind: "scenario_host",
    state: await deps.scenarioHostStateStore.ensureForSession(toScenarioHostSession(session))
  };
}

async function applySessionSnapshotModeState(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  modeState: SessionSnapshotModeState
): Promise<void> {
  if (modeState?.kind === "scenario_host") {
    await deps.scenarioHostStateStore.write(sessionId, modeState.state);
    return;
  }
  await deps.scenarioHostStateStore.delete(sessionId);
}

async function restorePreviousSnapshotModeState(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  previousModeState: ScenarioHostSessionState | null
): Promise<void> {
  if (previousModeState) {
    await deps.scenarioHostStateStore.write(sessionId, previousModeState);
    return;
  }
  await deps.scenarioHostStateStore.delete(sessionId);
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

export async function copySessionToWebSession(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  body: ParsedCopySessionBody
) {
  const sourceSession = findSession(deps, sessionId);
  if (!sourceSession) {
    return null;
  }
  assertSessionSnapshotMutationAllowed(sourceSession, "复制");

  const now = Date.now();
  const sourcePersisted = deps.sessionManager.getPersistedSession(sourceSession.id);
  const targetSessionId = createWebSessionId();
  const targetParticipantRef: SessionParticipantRef = sourcePersisted.participantRef.kind === "user"
    ? sourcePersisted.participantRef
    : { kind: "user", id: "owner" };
  const targetTitle = body.title?.trim()
    || buildCopiedSessionTitle(sourcePersisted.title ?? resolveDefaultSessionTitle(sourcePersisted.modeId ?? getDefaultSessionModeId()));
  const targetPersisted = buildCopiedWebSessionState(sourcePersisted, {
    id: targetSessionId,
    participantRef: targetParticipantRef,
    title: targetTitle,
    now
  });
  const modeState = remapCopiedSessionModeState(
    await captureSessionSnapshotModeState(deps, sourceSession),
    {
      sourceSessionId: sourcePersisted.id,
      sourceParticipantRef: sourcePersisted.participantRef,
      targetSessionId,
      targetParticipantRef,
      targetTitle
    }
  );

  let restored = false;
  try {
    await applySessionSnapshotModeState(deps, targetSessionId, modeState);
    const targetSession = deps.sessionManager.restorePersistedSession(targetPersisted);
    restored = true;
    await deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(targetSession.id));
    return {
      ok: true as const,
      session: buildSessionSummary(targetSession),
      modeState: await getSessionModeStateDetail(deps, targetSession)
    };
  } catch (error: unknown) {
    await deps.scenarioHostStateStore.delete(targetSessionId).catch(() => undefined);
    if (restored) {
      deps.sessionManager.deleteSession(targetSessionId);
    }
    await deps.sessionPersistence.remove(targetSessionId).catch(() => undefined);
    throw error;
  }
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
  const parsedState = scenarioHostSessionStateSchema.parse(stateInput);
  assertScenarioInitializedStateValid(parsedState);
  const state = await deps.scenarioHostStateStore.write(
    sessionId,
    parsedState
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
  if ("npcs" in patch && Array.isArray(state.npcs) && Array.isArray(baseState.npcs)) {
    patch.npcs = mergeCollectionByKey(
      current.npcs,
      baseState.npcs as unknown[],
      state.npcs as unknown[],
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

export async function updateSessionPacingPreferences(
  deps: InternalApiSessionWriteDeps,
  sessionId: string,
  body: ParsedUpdateSessionPacingBody
) {
  const pacingPreferences = deps.sessionManager.setPacingPreferences(sessionId, body);
  await deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(sessionId));
  return {
    ok: true as const,
    pacingPreferences
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
  await deps.sessionSnapshotStore.deleteAllForSession(sessionId);
  await deps.scenarioHostStateStore.delete(sessionId);
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

function buildCopiedSessionTitle(sourceTitle: string): string {
  const baseTitle = String(sourceTitle ?? "").trim() || "New Chat";
  return `${baseTitle} 副本`;
}

function buildCopiedWebSessionState(
  source: PersistedSessionState,
  target: {
    id: string;
    participantRef: SessionParticipantRef;
    title: string;
    now: number;
  }
): PersistedSessionState {
  return {
    ...structuredClone(source),
    id: target.id,
    type: "private",
    source: "web",
    participantRef: target.participantRef,
    title: target.title,
    titleSource: "manual",
    replyDelivery: "web",
    operationMode: createNormalSessionOperationMode(),
    debugControl: { enabled: false },
    pendingMessages: [],
    queuedGroupReplyTargets: [],
    pendingTranscriptGroupId: null,
    activeTranscriptGroupId: null,
    taskTracker: createEmptySessionTaskTracker(),
    debugMarkers: [],
    lastLlmUsage: null,
    sentMessages: [],
    latestGapMs: null,
    smoothedGapMs: null,
    lastActiveAt: target.now
  };
}

function remapCopiedSessionModeState(
  modeState: SessionSnapshotModeState,
  input: {
    sourceSessionId: string;
    sourceParticipantRef: SessionParticipantRef;
    targetSessionId: string;
    targetParticipantRef: SessionParticipantRef;
    targetTitle: string;
  }
): SessionSnapshotModeState {
  if (modeState?.kind !== "scenario_host") {
    return modeState;
  }
  if (input.sourceParticipantRef.kind === "user") {
    return modeState;
  }

  const sourceDefaultPlayerLabel = resolveSessionParticipantLabel({
    sessionId: input.sourceSessionId,
    participantRef: input.sourceParticipantRef,
    title: null
  });
  const targetDefaultPlayerLabel = resolveSessionParticipantLabel({
    sessionId: input.targetSessionId,
    participantRef: input.targetParticipantRef,
    title: input.targetTitle
  });
  return {
    kind: "scenario_host",
    state: {
      ...modeState.state,
      player: {
        ...modeState.state.player,
        userId: input.targetParticipantRef.id,
        displayName: modeState.state.player.displayName === sourceDefaultPlayerLabel
          ? targetDefaultPlayerLabel
          : modeState.state.player.displayName
      }
    }
  };
}

import Fastify from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { createTestAppConfig } from "./config-fixtures.tsx";
import { createTempDir } from "./temp-paths.ts";
import { registerBasicRoutes } from "../../src/internalApi/routes/basicRoutes.ts";
import { registerBrowserRoutes } from "../../src/internalApi/routes/browserRoutes.ts";
import { registerMessagingRoutes } from "../../src/internalApi/routes/messagingRoutes.ts";
import { registerShellRoutes } from "../../src/internalApi/routes/shellRoutes.ts";
import { registerUploadRoutes } from "../../src/internalApi/routes/uploadRoutes.ts";
import { createInternalApiServices, type InternalApiDeps } from "../../src/internalApi/types.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";
import type { ContextManagementItem } from "../../src/context/contextTypes.ts";
import type { ScenarioHostSessionState } from "../../src/modes/scenarioHost/types.ts";
import type { ShellRunParams, ShellRunResult, ShellSession } from "../../src/services/shell/types.ts";

export interface InternalApiFixtureState {
  sentMessages: Array<{ userId?: string; groupId?: string; text: string }>;
  deletedMessageIds: number[];
  sessions: Array<{
    id: string;
    type: "private" | "group";
    source: "onebot" | "web";
    modeId: string;
    participantRef: {
      kind: "user" | "group";
      id: string;
    };
    participantUserId: string;
    participantLabel: string | null;
    title: string | null;
    titleSource: "default" | "auto" | "manual" | null;
    phase: { kind: string };
    pendingMessages: Array<{ id?: number }>;
    internalTranscript: InternalTranscriptItem[];
    isGenerating: boolean;
    lastActiveAt: number;
  }>;
  scenarioHostStates: Record<string, ScenarioHostSessionState>;
  shellSessions: ShellSession[];
  closedSessionIds: string[];
  configCheckForUpdatesCount: number;
  whitelistReloadCount: number;
  schedulerReloadCount: number;
  browserProfiles: Array<{ profile_id: string; ownerSessionId: string }>;
  contextItems: ContextManagementItem[];
  workspaceRoot: string;
}

function createShellSession(overrides: Partial<ShellSession> = {}): ShellSession {
  const now = Date.now();
  return {
    id: "shell-1",
    command: "pwd",
    cwd: "/tmp",
    shell: "/bin/sh",
    login: true,
    tty: true,
    createdAtMs: now,
    updatedAtMs: now,
    status: "running",
    pid: 123,
    exitCode: null,
    signal: null,
    outputTail: "",
    error: null,
    ...overrides
  };
}

export function createInternalApiDeps(): InternalApiDeps & { __state: InternalApiFixtureState } {
  const sessionListeners = new Map<string, Set<() => void>>();
  const allSessionListeners = new Set<() => void>();
  const notifySessionChanged = (sessionId: string) => {
    const listeners = sessionListeners.get(sessionId);
    if (listeners) {
      for (const listener of listeners) {
        listener();
      }
    }
    for (const listener of allSessionListeners) {
      listener();
    }
  };
  const workspaceRoot = createTempDir("llm-bot-internal-api-workspace");
  const state: InternalApiFixtureState = {
    sentMessages: [],
    deletedMessageIds: [],
    sessions: [{
      id: "qqbot:p:10001",
      type: "private",
      source: "onebot",
      modeId: "rp_assistant",
      participantRef: { kind: "user", id: "10001" },
      participantUserId: "10001",
      participantLabel: "Alice",
      title: "Alice",
      titleSource: "manual",
      phase: { kind: "idle" },
      pendingMessages: [{ id: 1 }],
      internalTranscript: [],
      isGenerating: false,
      lastActiveAt: 123456
    }],
    scenarioHostStates: {},
    shellSessions: [createShellSession()],
    closedSessionIds: [],
    configCheckForUpdatesCount: 0,
    whitelistReloadCount: 0,
    schedulerReloadCount: 0,
    browserProfiles: [{ profile_id: "browser_profile_fixture", ownerSessionId: "qqbot:p:10001" }],
    contextItems: [{
      itemId: "ctx_fixture_chunk_1",
      scope: "user",
      sourceType: "chunk",
      retrievalPolicy: "search",
      status: "active",
      userId: "10001",
      sessionId: "qqbot:p:10001",
      title: "近期聊天片段",
      text: "Alice 最近在评估 Orama 版用户上下文检索。",
      kind: "recent_dialogue",
      source: "session_history",
      importance: 1,
      pinned: false,
      sensitivity: "normal",
      createdAt: 1000,
      updatedAt: 2000
    }, {
      itemId: "ctx_fixture_fact_1",
      scope: "user",
      sourceType: "fact",
      retrievalPolicy: "always",
      status: "active",
      userId: "10002",
      title: "用户偏好",
      text: "用户偏好简洁回答。",
      pinned: true,
      sensitivity: "normal",
      createdAt: 900,
      updatedAt: 1500
    }],
    workspaceRoot
  };

  mkdirSync(join(state.workspaceRoot, "docs"), { recursive: true });
  mkdirSync(join(state.workspaceRoot, "workspace", "media"), { recursive: true });
  writeFileSync(join(state.workspaceRoot, "notes.txt"), "line 1\nline 2\nline 3\n", "utf8");
  writeFileSync(join(state.workspaceRoot, "workspace", "media", "file_image_1.png"), Buffer.from("fixture-image"));

  const deps: InternalApiDeps = {
    config: createTestAppConfig({
      internalApi: {
        enabled: true,
        port: 3030
      },
      whitelist: {
        enabled: true
      }
    }),
    logger: pino({ level: "silent" }),
    sessionCaptioner: {
      isAvailable() {
        return true;
      },
      async generateTitle() {
        return "Generated title";
      }
    } as unknown as InternalApiDeps["sessionCaptioner"],
    oneBotClient: {
      async sendText(payload: { userId?: string; groupId?: string; text: string }) {
        state.sentMessages.push(payload);
        return { messageId: "123" };
      },
      async deleteMessage(messageId: number) {
        state.deletedMessageIds.push(messageId);
        return {};
      }
    } as unknown as InternalApiDeps["oneBotClient"],
    chatMessageFileGcService: {
      async sweep() {
        return { deletedFileIds: [] };
      }
    } as unknown as InternalApiDeps["chatMessageFileGcService"],
    chatFileStore: {
      async importBuffer(input: { kind: "image" | "animated_image" | "video" | "file" | "audio"; sourceName?: string; mimeType?: string; buffer: Buffer }) {
        return {
          fileId: `file_${input.kind}_1`,
          fileRef: `${input.kind}_fixture_1.bin`,
          kind: input.kind,
          origin: "user_upload",
          chatFilePath: `workspace/media/${input.sourceName ?? "file"}`,
          sourceName: input.sourceName ?? "file",
          mimeType: input.mimeType ?? "application/octet-stream",
          sizeBytes: input.buffer.byteLength,
          createdAtMs: Date.now(),
          sourceContext: {},
          caption: null
        };
      },
      async listFiles() {
        return [{
          fileId: "file_image_1",
          fileRef: "upload_image1.png",
          kind: "image",
          origin: "user_upload",
          chatFilePath: "workspace/media/file_image_1.png",
          sourceName: "fixture.png",
          mimeType: "image/png",
          sizeBytes: 13,
          createdAtMs: 123,
          sourceContext: {},
          caption: null
        }];
      },
      async getFile(fileId: string) {
        if (fileId !== "file_image_1") {
          return null;
        }
        return {
          fileId: "file_image_1",
          fileRef: "upload_image1.png",
          kind: "image",
          origin: "user_upload",
          chatFilePath: "workspace/media/file_image_1.png",
          sourceName: "fixture.png",
          mimeType: "image/png",
          sizeBytes: 13,
          createdAtMs: 123,
          sourceContext: {},
          caption: null
        };
      },
      async getMany(fileIds: string[]) {
        if (!fileIds.includes("file_image_1")) {
          return [];
        }
        return [{
          fileId: "file_image_1",
          fileRef: "upload_image1.png",
          kind: "image",
          origin: "user_upload",
          chatFilePath: "workspace/media/file_image_1.png",
          sourceName: "fixture.png",
          mimeType: "image/png",
          sizeBytes: 13,
          createdAtMs: 123,
          sourceContext: {},
          caption: null
        }];
      },
      async resolveAbsolutePath(fileId: string) {
        if (fileId !== "file_image_1") {
          throw new Error(`Unknown workspace file: ${fileId}`);
        }
        return join(state.workspaceRoot, "workspace", "media", "file_image_1.png");
      }
    } as unknown as InternalApiDeps["chatFileStore"],
    audioStore: {
      async getMany(audioIds: string[]) {
        return audioIds
          .filter((audioId) => audioId === "aud_fixture_1")
          .map((audioId) => ({
            id: audioId,
            source: "https://example.com/audio.mp3",
            createdAt: 123,
            transcription: "测试音频",
            transcriptionStatus: "ready" as const,
            transcriptionUpdatedAt: 124,
            transcriptionModelRef: "audio-model",
            transcriptionError: null
          }));
      }
    } as unknown as InternalApiDeps["audioStore"],
    localFileService: {
      rootDir: state.workspaceRoot,
      async listItems(relativePath = ".") {
        if (relativePath === "../escape") {
          throw new Error("Workspace path cannot escape the root directory");
        }
        if (relativePath === ".") {
          return {
            root: state.workspaceRoot,
            path: ".",
            items: [
              { path: "docs", name: "docs", kind: "directory", sizeBytes: 0, updatedAtMs: 1 },
              { path: "notes.txt", name: "notes.txt", kind: "file", sizeBytes: 20, updatedAtMs: 2 }
            ]
          };
        }
        if (relativePath === "docs") {
          return {
            root: state.workspaceRoot,
            path: "docs",
            items: []
          };
        }
        throw new Error(`Unknown workspace path: ${relativePath}`);
      },
      async statItem(relativePath: string) {
        if (relativePath === "../escape") {
          throw new Error("Workspace path cannot escape the root directory");
        }
        return {
          path: relativePath,
          name: relativePath.split("/").at(-1) ?? relativePath,
          kind: relativePath.endsWith(".txt") ? "file" : "directory",
          sizeBytes: relativePath.endsWith(".txt") ? 20 : 0,
          updatedAtMs: 2
        };
      },
      async readFile(relativePath: string, options?: { startLine?: number; endLine?: number }) {
        if (relativePath === "../escape") {
          throw new Error("Workspace path cannot escape the root directory");
        }
        if (relativePath !== "notes.txt") {
          throw new Error(`Workspace file is not a text file: ${relativePath}`);
        }
        return {
          path: "notes.txt",
          content: "line 1\nline 2",
          startLine: options?.startLine ?? 1,
          endLine: options?.endLine ?? 2,
          totalLines: 3,
          truncated: true
        };
      },
      async readFileContent(relativePath: string) {
        if (relativePath === "../escape") {
          throw new Error("Workspace path cannot escape the root directory");
        }
        if (relativePath !== "photo.png") {
          throw new Error(`Workspace path is not a file: ${relativePath}`);
        }
        return {
          path: "photo.png",
          contentType: "image/png",
          buffer: Buffer.from("fixture-image")
        };
      },
      resolvePath(relativePath: string) {
        if (relativePath === "../escape") {
          throw new Error("Workspace path cannot escape the root directory");
        }
        if (relativePath !== "photo.png") {
          throw new Error(`Workspace path is not a file: ${relativePath}`);
        }
        return {
          rootDir: state.workspaceRoot,
          relativePath,
          absolutePath: join(state.workspaceRoot, "workspace", "media", "file_image_1.png")
        };
      }
    } as unknown as InternalApiDeps["localFileService"],
    sessionManager: {
      __activeResponses: new Map<string, number>(),
      listSessions() {
        return state.sessions;
      },
      getSessionView(sessionId: string) {
        const session = state.sessions.find((item) => item.id === sessionId) ?? state.sessions[0]!;
        return {
          id: session.id,
          type: session.type,
          source: session.source,
          modeId: session.modeId,
          participantRef: session.participantRef,
          participantUserId: session.participantUserId,
          participantLabel: session.participantLabel,
          title: session.title,
          titleSource: session.titleSource,
          debugControl: {
            enabled: false,
            oncePending: false
          },
          historySummary: null,
          recentMessages: [],
          internalTranscript: session.internalTranscript,
          debugMarkers: [],
          lastLlmUsage: null,
          sentMessages: [],
          lastActiveAt: session.lastActiveAt
        };
      },
      getHistoryRevision() {
        return 0;
      },
      getMutationEpoch() {
        return 0;
      },
      getSession(sessionId: string) {
        const existing = state.sessions.find((item) => item.id === sessionId);
        return {
          id: sessionId,
          type: existing?.type ?? (sessionId.startsWith("qqbot:g:") ? "group" : "private"),
          source: existing?.source ?? (sessionId.startsWith("web:") ? "web" : "onebot"),
          modeId: existing?.modeId ?? "rp_assistant",
          participantRef: existing?.participantRef ?? {
            kind: (existing?.type ?? (sessionId.startsWith("qqbot:g:") ? "group" : "private")) === "group" ? "group" : "user",
            id: existing?.participantUserId ?? "10001"
          },
          participantUserId: existing?.participantUserId ?? "10001",
          participantLabel: existing?.participantLabel ?? "Alice",
          title: existing?.title ?? "Alice",
          titleSource: existing?.titleSource ?? "manual",
          phase: existing?.phase ?? { kind: "idle" },
          pendingMessages: [],
          debounceTimer: null,
          isGenerating: false,
          historyRevision: 0,
          mutationEpoch: 0,
          lastActiveAt: 123456,
          internalTranscript: existing?.internalTranscript ?? [],
          activeAssistantResponse: null,
          activeAssistantDraftResponse: null
        };
      },
      subscribeSession(sessionId: string, listener: () => void) {
        const listeners = sessionListeners.get(sessionId) ?? new Set<() => void>();
        listeners.add(listener);
        sessionListeners.set(sessionId, listeners);
        return () => {
          const activeListeners = sessionListeners.get(sessionId);
          if (!activeListeners) {
            return;
          }
          activeListeners.delete(listener);
          if (activeListeners.size === 0) {
            sessionListeners.delete(sessionId);
          }
        };
      },
      subscribeSessions(listener: () => void) {
        allSessionListeners.add(listener);
        return () => {
          allSessionListeners.delete(listener);
        };
      },
      ensureSession(target: {
        id: string;
        type: "private" | "group";
        source?: "onebot" | "web";
        participantRef?: {
          kind: "user" | "group";
          id: string;
        };
        title?: string | null;
        titleSource?: "default" | "auto" | "manual" | null;
      }) {
        const existing = state.sessions.find((item) => item.id === target.id);
        if (existing) {
          return existing;
        }
        const participantRef = target.participantRef ?? {
          kind: target.type === "group" ? "group" : "user",
          id: target.id
        };
        const title = target.title ?? null;
        const created = {
          id: target.id,
          type: target.type,
          source: target.source ?? "onebot",
          modeId: "rp_assistant",
          participantRef,
          participantUserId: participantRef.id,
          participantLabel: title ?? participantRef.id,
          title,
          titleSource: target.titleSource ?? (title ? "manual" : "default"),
          phase: { kind: "idle" },
          pendingMessages: [],
          internalTranscript: [],
          isGenerating: false,
          lastActiveAt: Date.now()
        };
        state.sessions.push(created);
        notifySessionChanged(target.id);
        return created;
      },
      deleteSession(sessionId: string) {
        const index = state.sessions.findIndex((item) => item.id === sessionId);
        if (index === -1) {
          return false;
        }
        state.sessions.splice(index, 1);
        notifySessionChanged(sessionId);
        return true;
      },
      excludeTranscriptItem(sessionId: string, itemId: string) {
        const session = state.sessions.find((item) => item.id === sessionId);
        if (!session) {
          return [];
        }
        const affected = session.internalTranscript.filter((item) => item.id === itemId && item.runtimeExcluded !== true);
        for (const item of affected) {
          item.runtimeExcluded = true;
          item.runtimeExcludedAt = Date.now();
          item.runtimeExclusionReason = "manual_single";
        }
        notifySessionChanged(sessionId);
        return affected;
      },
      excludeTranscriptGroup(sessionId: string, groupId: string) {
        const session = state.sessions.find((item) => item.id === sessionId);
        if (!session) {
          return [];
        }
        const affected = session.internalTranscript.filter((item) => item.groupId === groupId && item.runtimeExcluded !== true);
        for (const item of affected) {
          item.runtimeExcluded = true;
          item.runtimeExcludedAt = Date.now();
          item.runtimeExclusionReason = "manual_group";
        }
        notifySessionChanged(sessionId);
        return affected;
      },
      getPersistedSession(sessionId: string) {
        const session = state.sessions.find((item) => item.id === sessionId)!;
        return {
          id: session.id,
          type: session.type,
          source: session.source,
          modeId: session.modeId,
          participantRef: session.participantRef,
          participantUserId: session.participantUserId,
          participantLabel: session.participantLabel,
          title: session.title,
          titleSource: session.titleSource,
          pendingMessages: [],
          internalTranscript: session.internalTranscript,
          historySummary: null,
          debugMarkers: [],
          lastLlmUsage: null,
          sentMessages: [],
          lastActiveAt: session.lastActiveAt,
          lastMessageAt: null,
          latestGapMs: null,
          smoothedGapMs: null
        };
      },
      getLlmVisibleHistory() {
        return [];
      },
      appendSyntheticPendingMessage() {},
      appendHistory() {},
      appendInternalTranscript(sessionId: string, item: InternalTranscriptItem) {
        const session = state.sessions.find((entry) => entry.id === sessionId);
        if (!session) {
          return;
        }
        session.internalTranscript.push(item);
        notifySessionChanged(sessionId);
      },
      getModeId(sessionId: string) {
        return state.sessions.find((item) => item.id === sessionId)?.modeId ?? "rp_assistant";
      },
      setTitle(sessionId: string, title: string, titleSource: "default" | "auto" | "manual") {
        const session = state.sessions.find((item) => item.id === sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        session.title = title.trim();
        session.titleSource = titleSource;
        session.participantLabel = session.source === "web" ? session.title : session.participantLabel;
        notifySessionChanged(sessionId);
        return session as never;
      },
      setModeId(sessionId: string, modeId: string) {
        const session = state.sessions.find((item) => item.id === sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        if (session.modeId === modeId) {
          return false;
        }
        session.modeId = modeId;
        notifySessionChanged(sessionId);
        return true;
      },
      hasActiveResponse(sessionId: string) {
        const count = (this as { __activeResponses: Map<string, number> }).__activeResponses.get(sessionId) ?? 0;
        if (count <= 0) {
          return false;
        }
        (this as { __activeResponses: Map<string, number> }).__activeResponses.set(sessionId, count - 1);
        return true;
      }
    } as unknown as InternalApiDeps["sessionManager"],
    personaStore: {
      async get() {
        return { prompt: "persona" };
      }
    } as unknown as InternalApiDeps["personaStore"],
    globalRuleStore: {
      async getAll() {
        return [];
      }
    } as unknown as InternalApiDeps["globalRuleStore"],
    scenarioHostStateStore: {
      async get(sessionId: string) {
        return state.scenarioHostStates[sessionId] ?? null;
      },
      async ensure(sessionId: string, defaults: { playerUserId: string; playerDisplayName: string }) {
        const existing = state.scenarioHostStates[sessionId];
        if (existing) {
          return existing;
        }
        const created = {
          version: 1,
          currentSituation: "场景尚未开始，请根据玩家接下来的行动开始主持。",
          currentLocation: null,
          sceneSummary: "",
          player: {
            userId: defaults.playerUserId,
            displayName: defaults.playerDisplayName
          },
          inventory: [],
          objectives: [],
          worldFacts: [],
          flags: {},
          initialized: false,
          turnIndex: 0
        } satisfies ScenarioHostSessionState;
        state.scenarioHostStates[sessionId] = created;
        return created;
      },
      async ensureForSession(session: { id: string; participantRef: { kind: "user" | "group"; id: string }; title?: string | null }) {
        const existing = state.scenarioHostStates[session.id];
        if (existing) {
          return existing;
        }
        const created = {
          version: 1,
          currentSituation: "场景尚未开始，请根据玩家接下来的行动开始主持。",
          currentLocation: null,
          sceneSummary: "",
          player: {
            userId: session.participantRef.id,
            displayName: session.title ?? session.participantRef.id
          },
          inventory: [],
          objectives: [],
          worldFacts: [],
          flags: {},
          initialized: false,
          turnIndex: 0
        } satisfies ScenarioHostSessionState;
        state.scenarioHostStates[session.id] = created;
        return created;
      },
      async write(sessionId: string, nextState: ScenarioHostSessionState) {
        state.scenarioHostStates[sessionId] = nextState;
        return nextState;
      }
    } as unknown as InternalApiDeps["scenarioHostStateStore"],
    userStore: {
      async list() {
        return [{ userId: "10001", nickname: "Alice" }];
      }
    } as unknown as InternalApiDeps["userStore"],
    contextStore: {
      getStatus() {
        return {
          available: true,
          dbPath: "/tmp/context.sqlite"
        };
      },
      getContextStats() {
        return {
          rawMessages: 1,
          contextItems: state.contextItems.length,
          embeddings: 0,
          byScope: [{ scope: "user", count: state.contextItems.length }],
          bySourceType: [],
          byStatus: [],
          sqlitePageCount: 1,
          sqlitePageSize: 4096,
          sqliteBytes: 4096
        };
      },
      listContextItems(input: { userId?: string; scope?: string; sourceType?: string; status?: string; limit?: number; offset?: number } = {}) {
        const items = state.contextItems
          .filter((item) => !input.userId || item.userId === input.userId)
          .filter((item) => !input.scope || item.scope === input.scope)
          .filter((item) => !input.sourceType || item.sourceType === input.sourceType)
          .filter((item) => !input.status || item.status === input.status)
          .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.itemId.localeCompare(left.itemId));
        const offset = Math.max(input.offset ?? 0, 0);
        const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
        return {
          items: items.slice(offset, offset + limit),
          total: items.length
        };
      },
      deleteContextItem(itemId: string) {
        const index = state.contextItems.findIndex((item) => item.itemId === itemId);
        if (index === -1) {
          return { deleted: false };
        }
        state.contextItems[index] = {
          ...state.contextItems[index]!,
          status: "deleted",
          updatedAt: state.contextItems[index]!.updatedAt + 1
        };
        return { deleted: true };
      },
      updateContextItem(input: {
        itemId: string;
        title?: string | null;
        text?: string;
        retrievalPolicy?: "always" | "search" | "never";
        status?: "active" | "archived" | "deleted" | "superseded";
        sensitivity?: "normal" | "private" | "secret";
        pinned?: boolean;
        validTo?: number | null;
        supersededBy?: string | null;
      }) {
        const index = state.contextItems.findIndex((item) => item.itemId === input.itemId);
        if (index === -1) {
          return { updated: false, item: null };
        }
        const nextItem = {
          ...state.contextItems[index]!,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.retrievalPolicy !== undefined ? { retrievalPolicy: input.retrievalPolicy } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          updatedAt: state.contextItems[index]!.updatedAt + 1
        };
        if (input.title !== undefined) {
          if (input.title == null) {
            delete nextItem.title;
          } else {
            nextItem.title = input.title;
          }
        }
        if (input.validTo !== undefined) {
          if (input.validTo == null) {
            delete nextItem.validTo;
          } else {
            nextItem.validTo = input.validTo;
          }
        }
        if (input.supersededBy !== undefined) {
          if (input.supersededBy == null) {
            delete nextItem.supersededBy;
          } else {
            nextItem.supersededBy = input.supersededBy;
          }
        }
        state.contextItems[index] = nextItem;
        return { updated: true, item: state.contextItems[index] };
      },
      bulkDeleteContextItems(input: { userId?: string; sourceType?: string }) {
        let deletedCount = 0;
        state.contextItems = state.contextItems.map((item) => {
          if (
            item.status !== "deleted"
            && (!input.userId || item.userId === input.userId)
            && (!input.sourceType || item.sourceType === input.sourceType)
          ) {
            deletedCount += 1;
            return { ...item, status: "deleted" as const, updatedAt: item.updatedAt + 1 };
          }
          return item;
        });
        return { deletedCount };
      },
      exportContextItemsJsonl(input: { userId?: string } = {}) {
        const items = state.contextItems.filter((item) => !input.userId || item.userId === input.userId);
        return {
          count: items.length,
          jsonl: items.map((item) => JSON.stringify(item)).join("\n")
        };
      },
      importContextItemsJsonl(jsonl: string) {
        let importedCount = 0;
        let skippedCount = 0;
        for (const line of jsonl.split(/\r?\n/u)) {
          if (!line.trim()) {
            continue;
          }
          const item = JSON.parse(line) as (typeof state.contextItems)[number];
          if (!item.itemId || !item.text) {
            skippedCount += 1;
            continue;
          }
          const index = state.contextItems.findIndex((entry) => entry.itemId === item.itemId);
          if (index === -1) {
            state.contextItems.push(item);
          } else {
            state.contextItems[index] = item;
          }
          importedCount += 1;
        }
        return { importedCount, skippedCount };
      },
      setContextItemPinned(itemId: string, pinned: boolean) {
        const item = state.contextItems.find((entry) => entry.itemId === itemId);
        if (!item) {
          return { updated: false };
        }
        item.pinned = pinned;
        item.updatedAt += 1;
        return { updated: true };
      },
      compactUserSearchChunks() {
        return { compactedCount: 0 };
      },
      sweepDeletedItems() {
        const before = state.contextItems.length;
        state.contextItems = state.contextItems.filter((item) => item.status !== "deleted");
        return { deletedCount: before - state.contextItems.length };
      },
      clearEmbeddings() {
        return { deletedCount: 0 };
      }
    } as unknown as InternalApiDeps["contextStore"],
    contextEmbeddingService: {
      getStatus() {
        return {
          configured: true,
          modelRefs: ["embedding"],
          timeoutMs: 30000,
          textPreprocessVersion: "v1",
          chunkerVersion: "user-facts-v1"
        };
      }
    } as unknown as InternalApiDeps["contextEmbeddingService"],
    contextRetrievalService: {
      resetIndexes() {
        return { resetCount: 0 };
      },
      async rebuildUserIndexes() {
        return {
          userCount: 1,
          embeddedCount: 1,
          indexedCount: 1,
          skippedCount: 0,
          errors: []
        };
      },
      getLastDebugReport() {
        return null;
      }
    } as unknown as InternalApiDeps["contextRetrievalService"],
    userIdentityStore: {
      findIdentityByInternalUserIdSync(internalUserId: string) {
        return internalUserId === "owner"
          ? {
              channelId: "qqbot",
              scope: "private_user",
              externalId: "10001",
              internalUserId: "owner",
              createdAt: 1
            }
          : undefined;
      }
    } as unknown as InternalApiDeps["userIdentityStore"],
    whitelistStore: {
      getSnapshot() {
        return {
          users: ["10001"],
          groups: ["20001"]
        };
      },
      async reloadFromDisk() {
        state.whitelistReloadCount += 1;
        return {
          users: ["10001"],
          groups: ["20001"]
        };
      }
    } as unknown as InternalApiDeps["whitelistStore"],
    requestStore: {
      async listFriendRequests() {
        return [{ userId: "10002" }];
      },
      async listGroupRequests() {
        return [{ groupId: "20002", userId: "10003" }];
      }
    } as unknown as InternalApiDeps["requestStore"],
    scheduledJobStore: {
      async list() {
        return [{ id: "job-1", name: "daily" }];
      }
    } as unknown as InternalApiDeps["scheduledJobStore"],
    scheduler: {
      async reloadFromStore() {
        state.schedulerReloadCount += 1;
      }
    } as unknown as InternalApiDeps["scheduler"],
    shellRuntime: {
      listSessions() {
        return state.shellSessions;
      },
      async run(params: ShellRunParams): Promise<ShellRunResult | ShellSession> {
        return createShellSession({
          id: "shell-run",
          command: params.command,
          cwd: params.cwd ?? "/tmp",
          tty: params.tty ?? true,
          createdAtMs: 1,
          updatedAtMs: 2,
          pid: 999
        });
      },
      async interact(sessionId: string, input: string) {
        return {
          output: input,
          session: state.shellSessions.find((item) => item.id === sessionId) ?? createShellSession({ id: sessionId })
        };
      },
      async read(sessionId: string) {
        return {
          output: "pwd\n",
          session: state.shellSessions.find((item) => item.id === sessionId) ?? createShellSession({ id: sessionId })
        };
      },
      async signal(sessionId: string, signal: string) {
        return createShellSession({ id: sessionId, signal });
      },
      closeSession(sessionId: string) {
        state.closedSessionIds.push(sessionId);
      }
    } as unknown as InternalApiDeps["shellRuntime"],
    configManager: {
      async checkForUpdates() {
        state.configCheckForUpdatesCount += 1;
        return true;
      }
    } as unknown as InternalApiDeps["configManager"],
    sessionPersistence: {
      async save() {},
      async remove() {},
      async loadAll() {
        return state.sessions.map((session) => ({
          id: session.id,
          type: session.type,
          source: session.source,
          modeId: session.modeId,
          participantRef: session.participantRef,
          participantUserId: session.participantUserId,
          participantLabel: session.participantLabel,
          title: session.title,
          titleSource: session.titleSource,
          pendingMessages: [],
          internalTranscript: session.internalTranscript,
          historySummary: null,
          debugMarkers: [],
          lastLlmUsage: null,
          sentMessages: [],
          lastActiveAt: session.lastActiveAt,
          lastMessageAt: null,
          latestGapMs: null,
          smoothedGapMs: null
        }));
      },
      async getPersistedSessionMtimeMs() {
        return 987654321;
      }
    } as unknown as InternalApiDeps["sessionPersistence"],
    async handleWebIncomingMessage(incomingMessage, options) {
      const text = `web handled: ${options.sessionId ?? "derived"}: ${incomingMessage.text}`;
      options.draftOverlaySink?.appendDelta(text);
      options.draftOverlaySink?.complete();
    },
    browserService: {
      async listProfiles() {
        return {
          ok: true,
          profiles: state.browserProfiles.map((item) => ({
            ...item,
            createdAtMs: 1,
            lastUsedAtMs: 2,
            origins: ["https://example.com"],
            hasStorageState: true,
            hasSessionStorage: true
          }))
        };
      },
      async inspectProfile(profileId: string) {
        const profile = state.browserProfiles.find((item) => item.profile_id === profileId);
        if (!profile) {
          throw new Error(`Unknown profile_id: ${profileId}`);
        }
        return {
          ok: true,
          profile: {
            ...profile,
            createdAtMs: 1,
            lastUsedAtMs: 2,
            origins: ["https://example.com"],
            hasStorageState: true,
            hasSessionStorage: true
          }
        };
      },
      async saveProfile(profileId: string) {
        if (!state.browserProfiles.some((item) => item.profile_id === profileId)) {
          throw new Error(`Unknown profile_id: ${profileId}`);
        }
        return { ok: true, profile_id: profileId, saved: true };
      },
      async clearProfile(profileId: string) {
        const index = state.browserProfiles.findIndex((item) => item.profile_id === profileId);
        if (index === -1) {
          throw new Error(`Unknown profile_id: ${profileId}`);
        }
        state.browserProfiles.splice(index, 1);
        return { ok: true, profile_id: profileId, cleared: true };
      }
    } as unknown as InternalApiDeps["browserService"]
  };

  return Object.assign(deps, { __state: state });
}

export async function createInternalApiApp(deps: InternalApiDeps) {
  const app = Fastify({ logger: false });
  const services = createInternalApiServices(deps);
  registerBasicRoutes(app, services.basicRoutes);
  registerBrowserRoutes(app, services.browserRoutes);
  registerShellRoutes(app, services.shellRoutes);
  registerMessagingRoutes(app, services.messagingRoutes);
  registerUploadRoutes(app, services.uploadRoutes);
  await app.ready();
  return app;
}

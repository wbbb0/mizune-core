import Fastify from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { createTestAppConfig } from "./config-fixtures.tsx";
import { registerBasicRoutes } from "../../src/internalApi/routes/basicRoutes.ts";
import { registerBrowserRoutes } from "../../src/internalApi/routes/browserRoutes.ts";
import { registerMessagingRoutes } from "../../src/internalApi/routes/messagingRoutes.ts";
import { registerShellRoutes } from "../../src/internalApi/routes/shellRoutes.ts";
import { createInternalApiServices, type InternalApiDeps } from "../../src/internalApi/types.ts";
import type { ShellRunParams, ShellRunResult, ShellSession } from "../../src/services/shell/types.ts";

export interface InternalApiFixtureState {
  sentMessages: Array<{ userId?: string; groupId?: string; text: string }>;
  sessions: Array<{
    id: string;
    type: "private" | "group";
    source: "onebot" | "web";
    modeId: string;
    participantUserId: string;
    participantLabel: string | null;
    pendingMessages: Array<{ id?: number }>;
    isGenerating: boolean;
    lastActiveAt: number;
  }>;
  shellSessions: ShellSession[];
  closedSessionIds: string[];
  configCheckForUpdatesCount: number;
  whitelistReloadCount: number;
  schedulerReloadCount: number;
  browserProfiles: Array<{ profile_id: string; ownerSessionId: string }>;
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
  const state: InternalApiFixtureState = {
    sentMessages: [],
    sessions: [{
      id: "private:10001",
      type: "private",
      source: "onebot",
      modeId: "rp_assistant",
      participantUserId: "10001",
      participantLabel: "Alice",
      pendingMessages: [{ id: 1 }],
      isGenerating: false,
      lastActiveAt: 123456
    }],
    shellSessions: [createShellSession()],
    closedSessionIds: [],
    configCheckForUpdatesCount: 0,
    whitelistReloadCount: 0,
    schedulerReloadCount: 0,
    browserProfiles: [{ profile_id: "browser_profile_fixture", ownerSessionId: "private:10001" }],
    workspaceRoot: "/tmp/llm-bot-internal-api-workspace"
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
    oneBotClient: {
      async sendText(payload: { userId?: string; groupId?: string; text: string }) {
        state.sentMessages.push(payload);
        return { messageId: "123" };
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
      async resolveAbsolutePath(fileId: string) {
        if (fileId !== "file_image_1") {
          throw new Error(`Unknown workspace file: ${fileId}`);
        }
        return join(state.workspaceRoot, "workspace", "media", "file_image_1.png");
      }
    } as unknown as InternalApiDeps["chatFileStore"],
    mediaVisionService: {} as unknown as InternalApiDeps["mediaVisionService"],
    mediaCaptionService: {} as unknown as InternalApiDeps["mediaCaptionService"],
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
          participantUserId: session.participantUserId,
          participantLabel: session.participantLabel,
          debugControl: {
            enabled: false,
            oncePending: false
          },
          historySummary: null,
          recentMessages: [],
          internalTranscript: [],
          debugMarkers: [],
          recentToolEvents: [],
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
          type: existing?.type ?? (sessionId.startsWith("group:") ? "group" : "private"),
          source: existing?.source ?? (sessionId.startsWith("web:") ? "web" : "onebot"),
          modeId: existing?.modeId ?? "rp_assistant",
          participantUserId: existing?.participantUserId ?? "10001",
          participantLabel: existing?.participantLabel ?? "Alice",
          pendingMessages: [],
          debounceTimer: null,
          isGenerating: false,
          historyRevision: 0,
          mutationEpoch: 0,
          lastActiveAt: 123456,
          internalTranscript: [],
          activeAssistantResponse: null
        };
      },
      ensureSession(target: {
        id: string;
        type: "private" | "group";
        source?: "onebot" | "web";
        participantUserId?: string;
        participantLabel?: string | null;
      }) {
        const existing = state.sessions.find((item) => item.id === target.id);
        if (existing) {
          return existing;
        }
        const created = {
          id: target.id,
          type: target.type,
          source: target.source ?? "onebot",
          modeId: "rp_assistant",
          participantUserId: target.participantUserId ?? target.id,
          participantLabel: target.participantLabel ?? target.participantUserId ?? target.id,
          pendingMessages: [],
          isGenerating: false,
          lastActiveAt: Date.now()
        };
        state.sessions.push(created);
        return created;
      },
      deleteSession(sessionId: string) {
        const index = state.sessions.findIndex((item) => item.id === sessionId);
        if (index === -1) {
          return false;
        }
        state.sessions.splice(index, 1);
        return true;
      },
      getPersistedSession(sessionId: string) {
        const session = state.sessions.find((item) => item.id === sessionId)!;
        return {
          id: session.id,
          type: session.type,
          source: session.source,
          modeId: session.modeId,
          participantUserId: session.participantUserId,
          participantLabel: session.participantLabel,
          pendingMessages: [],
          historySummary: null,
          internalTranscript: [],
          debugMarkers: [],
          recentToolEvents: [],
          lastLlmUsage: null,
          sentMessages: [],
          lastActiveAt: session.lastActiveAt,
          lastMessageAt: null,
          latestGapMs: null,
          smoothedGapMs: null
        };
      },
      appendSyntheticPendingMessage() {},
      appendHistory() {},
      getModeId(sessionId: string) {
        return state.sessions.find((item) => item.id === sessionId)?.modeId ?? "rp_assistant";
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
    globalMemoryStore: {
      async getAll() {
        return [];
      }
    } as unknown as InternalApiDeps["globalMemoryStore"],
    scenarioHostStateStore: {
      async ensureForSession(session: { id: string; participantUserId: string; participantLabel?: string | null }) {
        return {
          version: 1,
          title: "未命名场景",
          currentSituation: "场景尚未开始，请根据玩家接下来的行动开始主持。",
          currentLocation: null,
          sceneSummary: "",
          player: {
            userId: session.participantUserId,
            displayName: session.participantLabel ?? session.participantUserId
          },
          inventory: [],
          objectives: [],
          worldFacts: [],
          flags: {},
          turnIndex: 0
        };
      }
    } as unknown as InternalApiDeps["scenarioHostStateStore"],
    userStore: {
      async list() {
        return [{ userId: "10001", nickname: "Alice" }];
      }
    } as unknown as InternalApiDeps["userStore"],
    whitelistStore: {
      getSnapshot() {
        return {
          ownerId: "10001",
          users: ["10001"],
          groups: ["20001"]
        };
      },
      async reloadFromDisk() {
        state.whitelistReloadCount += 1;
        return {
          ownerId: "10001",
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
      async getPersistedSessionMtimeMs() {
        return 987654321;
      }
    } as unknown as InternalApiDeps["sessionPersistence"],
    persistSession() {},
    flushSession(sessionId: string, options?: { delivery?: "onebot" | "web"; webOutputCollector?: { append: (chunk: string) => void } }) {
      if (options?.delivery === "web") {
        options.webOutputCollector?.append("web reply from fixture");
        const manager = deps.sessionManager as unknown as { __activeResponses: Map<string, number> };
        manager.__activeResponses.set(sessionId, 1);
      }
    },
    async handleWebIncomingMessage(incomingMessage, options) {
      options.webOutputCollector.append(`web handled: ${options.sessionId ?? "derived"}: ${incomingMessage.text}`);
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
  registerBasicRoutes(app, services);
  registerBrowserRoutes(app, services);
  registerShellRoutes(app, services);
  registerMessagingRoutes(app, services);
  await app.ready();
  return app;
}

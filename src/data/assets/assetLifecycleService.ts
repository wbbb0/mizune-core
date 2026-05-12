import type { Logger } from "pino";
import type { StoredAudioFile } from "#audio/audioStore.ts";
import type { ComfyTaskRecord } from "#comfy/taskSchema.ts";
import type { PersistedSessionState, SessionState } from "#conversation/session/sessionTypes.ts";
import type { ChatFileRecord } from "#services/workspace/types.ts";
import { AssetLifecycleStore, type AssetSessionRef } from "./assetLifecycleStore.ts";
import { collectSessionAssetRefs } from "./sessionAssetReferences.ts";

export interface AssetLifecycleConfig {
  enabled: boolean;
  ttlMs: number;
  orphanFileTtlMs: number;
  maxTotalBytes: number | null;
  targetTotalBytes: number | null;
}

export interface AssetLifecycleSweepInput {
  activeSessions: SessionState[];
  persistedSessions: PersistedSessionState[];
  now?: number;
}

export interface AssetLifecycleSweepResult {
  deletedChatFileIds: string[];
  deletedAudioIds: string[];
  deletedComfyTaskIds: string[];
  orphanFilesRemoved: number;
}

export class AssetLifecycleService {
  constructor(
    private readonly store: AssetLifecycleStore,
    private readonly deps: {
      chatFileStore: {
        listFiles: () => Promise<ChatFileRecord[]>;
        deleteFile: (fileId: string) => Promise<boolean>;
        cleanupOrphanDocumentCaches: () => Promise<{ removed: number; kept: number }>;
        cleanupOrphanMediaFiles: (input: { orphanTtlMs: number; now?: number }) => Promise<{ removed: number; kept: number }>;
      };
      audioStore: {
        listRows: (input?: { offset?: number; limit?: number }) => Promise<{ rows: StoredAudioFile[]; total: number; offset: number; limit: number }>;
        deleteAudio: (audioId: string) => Promise<boolean>;
      };
      comfyTaskStore: {
        listRows: (input?: { offset?: number; limit?: number }) => Promise<{ rows: ComfyTaskRecord[]; total: number; offset: number; limit: number }>;
        deleteById: (taskId: string) => Promise<boolean>;
      };
    },
    private readonly logger: Logger,
    private readonly config: AssetLifecycleConfig
  ) {}

  async init(): Promise<void> {
    await this.store.init();
  }

  async onSessionDeleted(input: { sessionId: string; activeSessions: SessionState[]; persistedSessions: PersistedSessionState[] }): Promise<AssetLifecycleSweepResult> {
    await this.store.removeSessionRefs(input.sessionId);
    return this.sweep({
      activeSessions: input.activeSessions,
      persistedSessions: input.persistedSessions
    });
  }

  async sweep(input: AssetLifecycleSweepInput): Promise<AssetLifecycleSweepResult> {
    if (!this.config.enabled) {
      return emptySweepResult();
    }
    const now = input.now ?? Date.now();
    const sessions = dedupeSessions([...input.persistedSessions, ...input.activeSessions]);
    const liveSessionIds = new Set(sessions.map((session) => session.id));
    await this.store.removeRefsForMissingSessions([...liveSessionIds]);
    await this.rebuildSessionRefs(sessions, now);
    await this.upsertComfyTaskRefs(now, liveSessionIds);
    await this.deps.chatFileStore.cleanupOrphanDocumentCaches();
    const mediaCleanup = await this.deps.chatFileStore.cleanupOrphanMediaFiles({
      orphanTtlMs: this.config.orphanFileTtlMs,
      now
    });

    const [chatFiles, audioFiles, comfyTasks] = await Promise.all([
      this.deps.chatFileStore.listFiles(),
      listAllRows((query) => this.deps.audioStore.listRows(query)),
      listAllRows((query) => this.deps.comfyTaskStore.listRows(query))
    ]);
    const [referencedChatFiles, referencedAudios, referencedComfyTasks] = await Promise.all([
      this.store.listReferencedAssetIds("chat_file"),
      this.store.listReferencedAssetIds("audio"),
      this.store.listReferencedAssetIds("comfy_task")
    ]);

    const deletedChatFileIds = await this.deleteUnreferencedChatFiles(chatFiles, referencedChatFiles, now);
    const deletedAudioIds = await this.deleteUnreferencedAudios(audioFiles, referencedAudios, now);
    const deletedComfyTaskIds = await this.deleteUnreferencedComfyTasks(comfyTasks, referencedComfyTasks, now);
    if (deletedChatFileIds.length || deletedAudioIds.length || deletedComfyTaskIds.length || mediaCleanup.removed > 0) {
      this.logger.info({
        deletedChatFileIds,
        deletedAudioIds,
        deletedComfyTaskIds,
        orphanMediaFilesRemoved: mediaCleanup.removed
      }, "asset_lifecycle_gc_completed");
    }
    return {
      deletedChatFileIds,
      deletedAudioIds,
      deletedComfyTaskIds,
      orphanFilesRemoved: mediaCleanup.removed
    };
  }

  private async rebuildSessionRefs(sessions: Array<SessionState | PersistedSessionState>, now: number): Promise<void> {
    const bySession = new Map<string, AssetSessionRef[]>();
    for (const ref of collectSessionAssetRefs(dedupeSessions(sessions), now)) {
      const refs = bySession.get(ref.sessionId) ?? [];
      refs.push(ref);
      bySession.set(ref.sessionId, refs);
    }
    for (const session of dedupeSessions(sessions)) {
      await this.store.replaceSessionRefs(session.id, bySession.get(session.id) ?? []);
    }
  }

  private async upsertComfyTaskRefs(now: number, liveSessionIds: Set<string>): Promise<void> {
    const tasks = await listAllRows((query) => this.deps.comfyTaskStore.listRows(query));
    await this.store.upsertRefs(tasks
      .filter((task) => liveSessionIds.has(task.sessionId))
      .flatMap((task) => [
        {
          assetKind: "comfy_task" as const,
          assetId: task.id,
          sessionId: task.sessionId,
          refKind: "task",
          createdAtMs: task.createdAtMs,
          lastSeenAtMs: now,
          expiresAtMs: null
        },
        ...task.resultFileIds.map((fileId) => ({
          assetKind: "chat_file" as const,
          assetId: fileId,
          sessionId: task.sessionId,
          refKind: "comfy_result",
          createdAtMs: task.createdAtMs,
          lastSeenAtMs: now,
          expiresAtMs: null
        }))
      ]));
  }

  private async deleteUnreferencedChatFiles(files: ChatFileRecord[], referenced: Set<string>, now: number): Promise<string[]> {
    const eligible = files
      .filter((file) => isLifecycleManagedChatFile(file))
      .filter((file) => !isReferencedChatFile(file, referenced))
      .filter((file) => now - file.createdAtMs >= this.config.ttlMs)
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.fileId.localeCompare(right.fileId));
    const selected = new Set(eligible.map((file) => file.fileId));
    for (const file of selectForSizePressure(files, referenced, this.config)) {
      selected.add(file.fileId);
    }
    const deleted: string[] = [];
    for (const file of files.filter((item) => selected.has(item.fileId))) {
      if (await this.deps.chatFileStore.deleteFile(file.fileId).catch(() => false)) {
        deleted.push(file.fileId);
      }
    }
    return deleted;
  }

  private async deleteUnreferencedAudios(files: StoredAudioFile[], referenced: Set<string>, now: number): Promise<string[]> {
    const deleted: string[] = [];
    for (const file of files
      .filter((item) => !referenced.has(item.id))
      .filter((item) => now - item.createdAt >= this.config.ttlMs)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      if (await this.deps.audioStore.deleteAudio(file.id).catch(() => false)) {
        deleted.push(file.id);
      }
    }
    return deleted;
  }

  private async deleteUnreferencedComfyTasks(tasks: ComfyTaskRecord[], referenced: Set<string>, now: number): Promise<string[]> {
    const deleted: string[] = [];
    for (const task of tasks
      .filter((item) => !referenced.has(item.id))
      .filter((item) => now - item.updatedAtMs >= this.config.ttlMs)
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs || left.id.localeCompare(right.id))) {
      if (await this.deps.comfyTaskStore.deleteById(task.id).catch(() => false)) {
        deleted.push(task.id);
      }
    }
    return deleted;
  }
}

async function listAllRows<T>(
  listRows: (input: { offset: number; limit: number }) => Promise<{ rows: T[]; total: number; offset: number; limit: number }>
): Promise<T[]> {
  const rows: T[] = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const page = await listRows({ offset, limit });
    rows.push(...page.rows);
    if (rows.length >= page.total || page.rows.length < limit) {
      return rows;
    }
  }
}

function selectForSizePressure(
  files: ChatFileRecord[],
  referenced: Set<string>,
  config: AssetLifecycleConfig
): ChatFileRecord[] {
  if (config.maxTotalBytes == null || config.targetTotalBytes == null) {
    return [];
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (total <= config.maxTotalBytes) {
    return [];
  }
  const target = Math.min(config.targetTotalBytes, config.maxTotalBytes);
  let nextTotal = total;
  const selected: ChatFileRecord[] = [];
  for (const file of files
    .filter((item) => isLifecycleManagedChatFile(item))
    .filter((item) => !isReferencedChatFile(item, referenced))
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.fileId.localeCompare(right.fileId))) {
    selected.push(file);
    nextTotal -= file.sizeBytes;
    if (nextTotal <= target) break;
  }
  return selected;
}

function isReferencedChatFile(file: ChatFileRecord, referenced: Set<string>): boolean {
  return referenced.has(file.fileId) || referenced.has(file.fileRef);
}

function isLifecycleManagedChatFile(file: ChatFileRecord): boolean {
  return file.origin === "chat_message"
    || file.origin === "browser_download"
    || file.origin === "browser_screenshot"
    || file.origin === "comfy_generated"
    || file.origin === "group_file_download";
}

function dedupeSessions<T extends { id: string }>(sessions: T[]): T[] {
  return Array.from(new Map(sessions.map((session) => [session.id, session])).values());
}

function emptySweepResult(): AssetLifecycleSweepResult {
  return {
    deletedChatFileIds: [],
    deletedAudioIds: [],
    deletedComfyTaskIds: [],
    orphanFilesRemoved: 0
  };
}

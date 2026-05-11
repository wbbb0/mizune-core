import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { AssetsDatabase } from "#data/assets/assetsDatabase.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import { comfyTaskRecordSchema, type ComfyTaskRecord } from "./taskSchema.ts";

export class ComfyTaskStore {
  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly assetsDatabase = new AssetsDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.assetsDatabase.init();
  }

  async list(): Promise<ComfyTaskRecord[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT
        id,
        session_id AS sessionId,
        user_id AS userId,
        template_id AS templateId,
        workflow_file AS workflowFile,
        workflow_snapshot_json AS workflowSnapshotJson,
        positive_prompt AS positivePrompt,
        aspect_ratio AS aspectRatio,
        resolved_width AS resolvedWidth,
        resolved_height AS resolvedHeight,
        comfy_prompt_id AS comfyPromptId,
        status,
        result_file_ids_json AS resultFileIdsJson,
        result_files_json AS resultFilesJson,
        auto_iteration_index AS autoIterationIndex,
        max_auto_iterations AS maxAutoIterations,
        last_error AS lastError,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        started_at_ms AS startedAtMs,
        finished_at_ms AS finishedAtMs
      FROM comfy_tasks
      ORDER BY created_at_ms DESC, id ASC
    `).all() as ComfyTaskRow[];
    return rows.map(rowToComfyTaskRecord);
  }

  async getById(taskId: string): Promise<ComfyTaskRecord | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT
        id,
        session_id AS sessionId,
        user_id AS userId,
        template_id AS templateId,
        workflow_file AS workflowFile,
        workflow_snapshot_json AS workflowSnapshotJson,
        positive_prompt AS positivePrompt,
        aspect_ratio AS aspectRatio,
        resolved_width AS resolvedWidth,
        resolved_height AS resolvedHeight,
        comfy_prompt_id AS comfyPromptId,
        status,
        result_file_ids_json AS resultFileIdsJson,
        result_files_json AS resultFilesJson,
        auto_iteration_index AS autoIterationIndex,
        max_auto_iterations AS maxAutoIterations,
        last_error AS lastError,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        started_at_ms AS startedAtMs,
        finished_at_ms AS finishedAtMs
      FROM comfy_tasks
      WHERE id = ?
    `).get(taskId) as ComfyTaskRow | undefined;
    return row ? rowToComfyTaskRecord(row) : null;
  }

  async listActive(): Promise<ComfyTaskRecord[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT
        id,
        session_id AS sessionId,
        user_id AS userId,
        template_id AS templateId,
        workflow_file AS workflowFile,
        workflow_snapshot_json AS workflowSnapshotJson,
        positive_prompt AS positivePrompt,
        aspect_ratio AS aspectRatio,
        resolved_width AS resolvedWidth,
        resolved_height AS resolvedHeight,
        comfy_prompt_id AS comfyPromptId,
        status,
        result_file_ids_json AS resultFileIdsJson,
        result_files_json AS resultFilesJson,
        auto_iteration_index AS autoIterationIndex,
        max_auto_iterations AS maxAutoIterations,
        last_error AS lastError,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        started_at_ms AS startedAtMs,
        finished_at_ms AS finishedAtMs
      FROM comfy_tasks
      WHERE status IN ('queued', 'running')
      ORDER BY updated_at_ms DESC, id ASC
    `).all() as ComfyTaskRow[];
    return rows.map(rowToComfyTaskRecord);
  }

  async create(input: Omit<ComfyTaskRecord, "id" | "createdAtMs" | "updatedAtMs">): Promise<ComfyTaskRecord> {
    const now = Date.now();
    const created: ComfyTaskRecord = {
      ...input,
      id: randomUUID(),
      createdAtMs: now,
      updatedAtMs: now
    };
    const db = await this.getReadyDb();
    db.prepare(`
      INSERT INTO comfy_tasks (
        id,
        session_id,
        user_id,
        template_id,
        workflow_file,
        workflow_snapshot_json,
        positive_prompt,
        aspect_ratio,
        resolved_width,
        resolved_height,
        comfy_prompt_id,
        status,
        result_file_ids_json,
        result_files_json,
        auto_iteration_index,
        max_auto_iterations,
        last_error,
        created_at_ms,
        updated_at_ms,
        started_at_ms,
        finished_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...comfyTaskRecordToParams(created));
    return created;
  }

  async update(task: ComfyTaskRecord): Promise<void> {
    const db = await this.getReadyDb();
    const next = {
      ...task,
      updatedAtMs: Date.now()
    };
    db.prepare(`
      UPDATE comfy_tasks
      SET session_id = ?,
          user_id = ?,
          template_id = ?,
          workflow_file = ?,
          workflow_snapshot_json = ?,
          positive_prompt = ?,
          aspect_ratio = ?,
          resolved_width = ?,
          resolved_height = ?,
          comfy_prompt_id = ?,
          status = ?,
          result_file_ids_json = ?,
          result_files_json = ?,
          auto_iteration_index = ?,
          max_auto_iterations = ?,
          last_error = ?,
          created_at_ms = ?,
          updated_at_ms = ?,
          started_at_ms = ?,
          finished_at_ms = ?
      WHERE id = ?
    `).run(...comfyTaskRecordToUpdateParams(next));
  }

  async updateById(
    taskId: string,
    updater: (task: ComfyTaskRecord) => ComfyTaskRecord
  ): Promise<ComfyTaskRecord | null> {
    const current = await this.getById(taskId);
    if (!current) {
      return null;
    }
    const updated = {
      ...updater(current),
      updatedAtMs: Date.now()
    };
    await this.update(updated);
    return updated;
  }

  private async getReadyDb(): Promise<SqliteDatabase> {
    await this.assetsDatabase.init();
    return this.assetsDatabase.getDb();
  }
}

type ComfyTaskRow = {
  id: string;
  sessionId: string;
  userId: string;
  templateId: string;
  workflowFile: string;
  workflowSnapshotJson: string;
  positivePrompt: string;
  aspectRatio: string;
  resolvedWidth: number;
  resolvedHeight: number;
  comfyPromptId: string;
  status: ComfyTaskRecord["status"];
  resultFileIdsJson: string;
  resultFilesJson: string;
  autoIterationIndex: number;
  maxAutoIterations: number;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
};

function rowToComfyTaskRecord(row: ComfyTaskRow): ComfyTaskRecord {
  return comfyTaskRecordSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    templateId: row.templateId,
    workflowFile: row.workflowFile,
    workflowSnapshot: parseJsonObject(row.workflowSnapshotJson),
    positivePrompt: row.positivePrompt,
    aspectRatio: row.aspectRatio,
    resolvedWidth: row.resolvedWidth,
    resolvedHeight: row.resolvedHeight,
    comfyPromptId: row.comfyPromptId,
    status: row.status,
    resultFileIds: parseJsonArray(row.resultFileIdsJson),
    resultFiles: parseJsonArray(row.resultFilesJson),
    autoIterationIndex: row.autoIterationIndex,
    maxAutoIterations: row.maxAutoIterations,
    lastError: row.lastError,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs
  });
}

function comfyTaskRecordToParams(task: ComfyTaskRecord): [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  number,
  string,
  ComfyTaskRecord["status"],
  string,
  string,
  number,
  number,
  string | null,
  number,
  number,
  number | null,
  number | null
] {
  return [
    task.id,
    task.sessionId,
    task.userId,
    task.templateId,
    task.workflowFile,
    JSON.stringify(task.workflowSnapshot),
    task.positivePrompt,
    task.aspectRatio,
    task.resolvedWidth,
    task.resolvedHeight,
    task.comfyPromptId,
    task.status,
    JSON.stringify(task.resultFileIds),
    JSON.stringify(task.resultFiles),
    task.autoIterationIndex,
    task.maxAutoIterations,
    task.lastError,
    task.createdAtMs,
    task.updatedAtMs,
    task.startedAtMs,
    task.finishedAtMs
  ];
}

function comfyTaskRecordToUpdateParams(task: ComfyTaskRecord): [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  number,
  string,
  ComfyTaskRecord["status"],
  string,
  string,
  number,
  number,
  string | null,
  number,
  number,
  number | null,
  number | null,
  string
] {
  const [id, ...rest] = comfyTaskRecordToParams(task);
  return [...rest, id];
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

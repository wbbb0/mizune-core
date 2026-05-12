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
        ${COMFY_TASK_SELECT}
      FROM comfy_tasks
      ORDER BY created_at_ms DESC, id ASC
    `).all() as ComfyTaskRow[];
    const results = listResultFilesForTasks(db, rows.map((row) => row.id));
    return rows.map((row) => rowToComfyTaskRecord(row, results.get(row.id) ?? []));
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: ComfyTaskRecord[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM comfy_tasks`).get() as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        ${COMFY_TASK_SELECT}
      FROM comfy_tasks
      ORDER BY created_at_ms DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ComfyTaskRow[];
    const results = listResultFilesForTasks(db, rows.map((row) => row.id));
    return {
      rows: rows.map((row) => rowToComfyTaskRecord(row, results.get(row.id) ?? [])),
      total,
      offset,
      limit
    };
  }

  async listResultRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: ComfyTaskResultFileRegistryRow[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
    const taskId = typeof input.filters?.taskId === "string" && input.filters.taskId.trim()
      ? input.filters.taskId.trim()
      : null;
    const whereSql = taskId ? "WHERE task_id = ?" : "";
    const params = taskId ? [taskId] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM comfy_task_result_files ${whereSql}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        task_id AS taskId,
        result_index AS resultIndex,
        file_id AS fileId,
        filename,
        subfolder,
        type
      FROM comfy_task_result_files
      ${whereSql}
      ORDER BY task_id ASC, result_index ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ComfyTaskResultFileRegistryRow[];
    return { rows, total, offset, limit };
  }

  async getById(taskId: string): Promise<ComfyTaskRecord | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT
        ${COMFY_TASK_SELECT}
      FROM comfy_tasks
      WHERE id = ?
    `).get(taskId) as ComfyTaskRow | undefined;
    return row ? rowToComfyTaskRecord(row, listResultFilesForTask(db, row.id)) : null;
  }

  async listActive(): Promise<ComfyTaskRecord[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT
        ${COMFY_TASK_SELECT}
      FROM comfy_tasks
      WHERE status IN ('queued', 'running')
      ORDER BY updated_at_ms DESC, id ASC
    `).all() as ComfyTaskRow[];
    const results = listResultFilesForTasks(db, rows.map((row) => row.id));
    return rows.map((row) => rowToComfyTaskRecord(row, results.get(row.id) ?? []));
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
    db.transaction((task: ComfyTaskRecord) => {
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
          auto_iteration_index,
          max_auto_iterations,
          last_error,
          created_at_ms,
          updated_at_ms,
          started_at_ms,
          finished_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...comfyTaskRecordToParams(task));
      replaceResultFiles(db, task);
    })(created);
    return created;
  }

  async update(task: ComfyTaskRecord): Promise<void> {
    const db = await this.getReadyDb();
    const next = {
      ...task,
      updatedAtMs: Date.now()
    };
    db.transaction((task: ComfyTaskRecord) => {
      const result = db.prepare(`
        UPDATE comfy_tasks
        SET status = ?,
            auto_iteration_index = ?,
            max_auto_iterations = ?,
            last_error = ?,
            updated_at_ms = ?,
            started_at_ms = ?,
            finished_at_ms = ?
        WHERE id = ?
      `).run(
        task.status,
        task.autoIterationIndex,
        task.maxAutoIterations,
        task.lastError,
        task.updatedAtMs,
        task.startedAtMs,
        task.finishedAtMs,
        task.id
      );
      if (result.changes > 0) {
        replaceResultFiles(db, task);
      }
    })(next);
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
  autoIterationIndex: number;
  maxAutoIterations: number;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
};

type ComfyTaskResultFileRow = {
  task_id: string;
  result_index: number;
  file_id: string | null;
  filename: string;
  subfolder: string;
  type: string;
};

export interface ComfyTaskResultFileRegistryRow {
  taskId: string;
  resultIndex: number;
  fileId: string | null;
  filename: string;
  subfolder: string;
  type: string;
}

const COMFY_TASK_SELECT = `
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
        auto_iteration_index AS autoIterationIndex,
        max_auto_iterations AS maxAutoIterations,
        last_error AS lastError,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        started_at_ms AS startedAtMs,
        finished_at_ms AS finishedAtMs
`;

function rowToComfyTaskRecord(row: ComfyTaskRow, resultRows: ComfyTaskResultFileRow[]): ComfyTaskRecord {
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
    resultFileIds: resultRows.map((result) => result.file_id).filter((fileId): fileId is string => Boolean(fileId)),
    resultFiles: resultRows.map((result) => ({
      filename: result.filename,
      subfolder: result.subfolder,
      type: result.type
    })),
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
    task.autoIterationIndex,
    task.maxAutoIterations,
    task.lastError,
    task.createdAtMs,
    task.updatedAtMs,
    task.startedAtMs,
    task.finishedAtMs
  ];
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

function replaceResultFiles(db: SqliteDatabase, task: ComfyTaskRecord): void {
  db.prepare(`DELETE FROM comfy_task_result_files WHERE task_id = ?`).run(task.id);
  const insert = db.prepare(`
    INSERT INTO comfy_task_result_files (
      task_id,
      result_index,
      file_id,
      filename,
      subfolder,
      type
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [index, result] of task.resultFiles.entries()) {
    insert.run(
      task.id,
      index,
      task.resultFileIds[index] ?? null,
      result.filename,
      result.subfolder,
      result.type
    );
  }
}

function listResultFilesForTask(db: SqliteDatabase, taskId: string): ComfyTaskResultFileRow[] {
  return db.prepare(`
    SELECT task_id, result_index, file_id, filename, subfolder, type
    FROM comfy_task_result_files
    WHERE task_id = ?
    ORDER BY result_index ASC
  `).all(taskId) as ComfyTaskResultFileRow[];
}

function listResultFilesForTasks(db: SqliteDatabase, taskIds: string[]): Map<string, ComfyTaskResultFileRow[]> {
  const results = new Map<string, ComfyTaskResultFileRow[]>();
  if (taskIds.length === 0) {
    return results;
  }
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT task_id, result_index, file_id, filename, subfolder, type
    FROM comfy_task_result_files
    WHERE task_id IN (${placeholders})
    ORDER BY task_id ASC, result_index ASC
  `).all(...taskIds) as ComfyTaskResultFileRow[];
  for (const row of rows) {
    const current = results.get(row.task_id) ?? [];
    current.push(row);
    results.set(row.task_id, current);
  }
  return results;
}

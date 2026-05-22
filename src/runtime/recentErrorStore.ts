import type { Logger } from "pino";
import { StateDatabase } from "#data/state/stateDatabase.ts";

export const RECENT_ERROR_LIMIT = 50;
const RECENT_ERROR_REPORT_MAX_CHARS = 12_000;

export type RecentErrorLevel = "error" | "fatal";

export interface RecentErrorLogInput {
  level: RecentErrorLevel;
  capturedAtMs?: number;
  event: string;
  message: string;
  errorName?: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export interface RecentErrorRecord {
  id: number;
  capturedAtMs: number;
  level: RecentErrorLevel;
  event: string;
  message: string;
  errorName: string | null;
  stack: string | null;
  context: Record<string, unknown>;
}

export interface RecentErrorRowsInput {
  offset?: number;
  limit?: number;
}

export class RecentErrorCapture {
  private store: Pick<RecentErrorStore, "record"> | null = null;
  private pending: RecentErrorLogInput[] = [];

  bind(store: Pick<RecentErrorStore, "record">): void {
    this.store = store;
    const pending = this.pending.splice(0);
    for (const input of pending) {
      store.record(input);
    }
  }

  record(input: RecentErrorLogInput): void {
    if (this.store) {
      this.store.record(input);
      return;
    }
    this.pending.push(input);
    trimPending(this.pending);
  }
}

export class RecentErrorStore {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private pending: RecentErrorLogInput[] = [];
  private writeQueue: RecentErrorLogInput[] = [];
  private flushScheduled = false;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    await this.stateDatabase.init();
    this.initialized = true;
    const pending = this.pending.splice(0);
    for (const input of pending) {
      this.enqueueWrite(input);
    }
  }

  record(input: RecentErrorLogInput): void {
    if (!this.initialized) {
      this.pending.push(input);
      trimPending(this.pending);
      return;
    }
    this.enqueueWrite(input);
  }

  async listRecent(count = 1): Promise<RecentErrorRecord[]> {
    await this.init();
    this.flushWrites();
    const limit = clampCount(count);
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        id,
        captured_at_ms AS capturedAtMs,
        level,
        event,
        message,
        error_name AS errorName,
        stack,
        context_json AS contextJson
      FROM recent_errors
      ORDER BY captured_at_ms DESC, id DESC
      LIMIT ?
    `).all(limit) as RecentErrorRow[];
    return rows.map(toRecentErrorRecord);
  }

  async listRows(input: RecentErrorRowsInput = {}): Promise<{ rows: RecentErrorRecord[]; total: number; offset: number; limit: number }> {
    await this.init();
    this.flushWrites();
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
    const total = (this.stateDatabase.getDb().prepare("SELECT COUNT(*) AS count FROM recent_errors").get() as { count: number }).count;
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        id,
        captured_at_ms AS capturedAtMs,
        level,
        event,
        message,
        error_name AS errorName,
        stack,
        context_json AS contextJson
      FROM recent_errors
      ORDER BY captured_at_ms DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as RecentErrorRow[];
    return {
      rows: rows.map(toRecentErrorRecord),
      total,
      offset,
      limit
    };
  }

  async formatRecent(count: number, timeZone: string): Promise<string> {
    const records = await this.listRecent(count);
    if (records.length === 0) {
      return "最近没有记录到 error/fatal 日志。";
    }
    return formatRecentErrorRecords(records, timeZone);
  }

  private insert(input: RecentErrorLogInput): void {
    const normalized = normalizeRecentErrorInput(input);
    this.stateDatabase.getDb().transaction((entry: NormalizedRecentErrorInput) => {
      this.stateDatabase.getDb().prepare(`
        INSERT INTO recent_errors (
          captured_at_ms,
          level,
          event,
          message,
          error_name,
          stack,
          context_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.capturedAtMs,
        entry.level,
        entry.event,
        entry.message,
        entry.errorName,
        entry.stack,
        JSON.stringify(entry.context)
      );
      this.stateDatabase.getDb().prepare(`
        DELETE FROM recent_errors
        WHERE id NOT IN (
          SELECT id
          FROM recent_errors
          ORDER BY captured_at_ms DESC, id DESC
          LIMIT ?
        )
      `).run(RECENT_ERROR_LIMIT);
    })(normalized);
  }

  private enqueueWrite(input: RecentErrorLogInput): void {
    this.writeQueue.push(input);
    trimPending(this.writeQueue);
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushWrites();
    });
  }

  private flushWrites(): void {
    const queue = this.writeQueue.splice(0);
    for (const input of queue) {
      try {
        this.insert(input);
      } catch (error: unknown) {
        this.logger.warn({ error }, "recent_error_record_failed");
      }
    }
  }
}

interface NormalizedRecentErrorInput {
  level: RecentErrorLevel;
  capturedAtMs: number;
  event: string;
  message: string;
  errorName: string | null;
  stack: string | null;
  context: Record<string, unknown>;
}

interface RecentErrorRow {
  id: number;
  capturedAtMs: number;
  level: RecentErrorLevel;
  event: string;
  message: string;
  errorName: string | null;
  stack: string | null;
  contextJson: string;
}

function normalizeRecentErrorInput(input: RecentErrorLogInput): NormalizedRecentErrorInput {
  return {
    level: input.level,
    capturedAtMs: Math.max(0, Math.trunc(input.capturedAtMs ?? Date.now())),
    event: compactText(input.event.trim(), 160),
    message: compactText(input.message.trim() || input.event.trim() || "unknown error", 1_000),
    errorName: input.errorName?.trim() ? compactText(input.errorName.trim(), 120) : null,
    stack: input.stack?.trim() ? compactText(input.stack.trim(), 4_000) : null,
    context: sanitizeContext(input.context ?? {})
  };
}

function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, compactContextValue(value)])
  );
}

function compactContextValue(value: unknown): unknown {
  if (typeof value === "string") {
    return compactText(value, 300);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  return compactText(stringifyUnknown(value), 300);
}

function toRecentErrorRecord(row: RecentErrorRow): RecentErrorRecord {
  return {
    id: row.id,
    capturedAtMs: row.capturedAtMs,
    level: row.level,
    event: row.event,
    message: row.message,
    errorName: row.errorName,
    stack: row.stack,
    context: parseContextJson(row.contextJson)
  };
}

function parseContextJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function formatRecentErrorRecords(records: RecentErrorRecord[], timeZone: string): string {
  const parts = [`最近 ${records.length} 条报错：`];
  for (const [index, record] of records.entries()) {
    parts.push(formatRecentErrorRecord(record, index + 1, timeZone));
    const report = parts.join("\n\n");
    if (report.length > RECENT_ERROR_REPORT_MAX_CHARS) {
      return `${report.slice(0, RECENT_ERROR_REPORT_MAX_CHARS)}\n\n[输出已截断]`;
    }
  }
  return parts.join("\n\n");
}

function formatRecentErrorRecord(record: RecentErrorRecord, index: number, timeZone: string): string {
  const lines = [
    `#${index} ${formatTimestamp(record.capturedAtMs, timeZone)} ${record.level.toUpperCase()} ${record.event || "(no event)"}`,
    record.errorName ? `${record.errorName}: ${record.message}` : record.message
  ];
  const context = formatContext(record.context);
  if (context) {
    lines.push(`context: ${context}`);
  }
  if (record.stack) {
    lines.push(compactText(record.stack, 1_200));
  }
  return lines.join("\n");
}

function formatContext(context: Record<string, unknown>): string {
  return Object.entries(context)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function formatTimestamp(timestampMs: number, timeZone: string): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return String(timestampMs);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function clampCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 1;
  }
  return Math.min(RECENT_ERROR_LIMIT, Math.max(1, Math.trunc(count)));
}

function trimPending(pending: RecentErrorLogInput[]): void {
  if (pending.length > RECENT_ERROR_LIMIT) {
    pending.splice(0, pending.length - RECENT_ERROR_LIMIT);
  }
}

function compactText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}...`;
}

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

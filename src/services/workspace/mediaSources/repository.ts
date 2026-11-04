import { createHash, randomUUID } from "node:crypto";
import { AssetsDatabase } from "#data/assets/assetsDatabase.ts";
import type { Logger } from "pino";
import type { MediaScope, MediaSourceInput, MediaSourceRecord, MediaSourceRepository } from "./types.ts";

const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_SOURCES = 50_000;

/** Private URLs and platform locators never leave the asset database. */
export class SqliteMediaSourceRepository implements MediaSourceRepository {
  constructor(private readonly database: AssetsDatabase, private readonly now = Date.now) {}

  async register(scope: MediaScope, input: MediaSourceInput): Promise<MediaSourceRecord> {
    await this.database.init();
    const db = this.database.getDb();
    const key = createHash("sha256").update(JSON.stringify([scope, input.kind, input.locator ?? input.source])).digest("hex");
    return db.transaction(() => {
      const now = this.now();
      db.prepare("DELETE FROM media_sources WHERE expires_at_ms <= ?").run(now);
      const row = db.prepare("SELECT record_json FROM media_sources WHERE source_key = ?").get(key) as { record_json: string } | undefined;
      if (row) {
        const record = JSON.parse(row.record_json) as MediaSourceRecord;
        if (record.input.source !== input.source) { record.failures = 0; record.nextRetryAt = 0; record.version += 1; }
        record.input = input;
        record.expiresAt = now + RETENTION_MS;
        this.write(record);
        return record;
      }
      const count = db.prepare("SELECT COUNT(*) AS count FROM media_sources").get() as { count: number };
      if (count.count >= MAX_SOURCES) throw new Error("媒体来源登记数量已达到上限");
      const record: MediaSourceRecord = { ...scope, id: `media_${randomUUID().replaceAll("-", "")}`, key, input,
        assetId: null, failures: 0, nextRetryAt: 0, expiresAt: now + RETENTION_MS, version: 1 };
      this.write(record);
      return record;
    }).immediate();
  }

  async get(scope: MediaScope, id: string): Promise<MediaSourceRecord | null> {
    await this.database.init();
    const row = this.database.getDb().prepare(`SELECT record_json FROM media_sources
      WHERE id = ? AND connection_id = ? AND session_id = ? AND expires_at_ms > ?`)
      .get(id, scope.connectionId, scope.sessionId, this.now()) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as MediaSourceRecord : null;
  }

  async save(record: MediaSourceRecord): Promise<void> {
    await this.database.init();
    this.database.getDb().transaction(() => {
      const row = this.database.getDb().prepare("SELECT record_json FROM media_sources WHERE id = ? AND connection_id = ? AND session_id = ?")
        .get(record.id, record.connectionId, record.sessionId) as { record_json: string } | undefined;
      if (!row || (JSON.parse(row.record_json) as MediaSourceRecord).version !== record.version) return;
      record.version += 1;
      this.write(record);
    }).immediate();
  }

  private write(record: MediaSourceRecord): void {
    this.database.getDb().prepare(`INSERT INTO media_sources
      (id, source_key, connection_id, session_id, expires_at_ms, record_json) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET expires_at_ms=excluded.expires_at_ms, record_json=excluded.record_json`)
      .run(record.id, record.key, record.connectionId, record.sessionId, record.expiresAt, JSON.stringify(record));
  }
}

export function createMediaSourceRepository(dataDir: string, logger: Logger): SqliteMediaSourceRepository {
  return new SqliteMediaSourceRepository(new AssetsDatabase(dataDir, logger));
}

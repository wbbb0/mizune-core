import type { Logger } from "pino";
import { AssetsDatabase } from "./assetsDatabase.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";

export type AssetKind = "chat_file" | "audio" | "comfy_task" | "content_safety_audit";

export interface AssetSessionRef {
  assetKind: AssetKind;
  assetId: string;
  sessionId: string;
  refKind: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number | null;
}

export class AssetLifecycleStore {
  constructor(
    dataDir: string,
    logger: Logger,
    private readonly assetsDatabase = new AssetsDatabase(dataDir, logger)
  ) {}

  async init(): Promise<void> {
    await this.assetsDatabase.init();
  }

  async replaceSessionRefs(sessionId: string, refs: AssetSessionRef[]): Promise<void> {
    const normalizedSessionId = normalizeId(sessionId);
    const db = await this.getReadyDb();
    db.transaction(() => {
      db.prepare("DELETE FROM asset_session_refs WHERE session_id = ?").run(normalizedSessionId);
      this.insertRefs(db, refs.map((ref) => ({ ...ref, sessionId: normalizedSessionId })));
    })();
  }

  async removeSessionRefs(sessionId: string): Promise<void> {
    const normalizedSessionId = normalizeId(sessionId);
    const db = await this.getReadyDb();
    db.prepare("DELETE FROM asset_session_refs WHERE session_id = ?").run(normalizedSessionId);
  }

  async removeRefsForMissingSessions(sessionIds: string[]): Promise<void> {
    const db = await this.getReadyDb();
    const normalizedSessionIds = Array.from(new Set(sessionIds.map((id) => normalizeId(id))));
    if (normalizedSessionIds.length === 0) {
      db.prepare("DELETE FROM asset_session_refs").run();
      return;
    }
    const placeholders = normalizedSessionIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM asset_session_refs WHERE session_id NOT IN (${placeholders})`).run(...normalizedSessionIds);
  }

  async upsertRefs(refs: AssetSessionRef[]): Promise<void> {
    if (refs.length === 0) return;
    const db = await this.getReadyDb();
    db.transaction(() => {
      this.insertRefs(db, refs);
    })();
  }

  async listRefs(): Promise<AssetSessionRef[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT
        asset_kind AS assetKind,
        asset_id AS assetId,
        session_id AS sessionId,
        ref_kind AS refKind,
        created_at_ms AS createdAtMs,
        last_seen_at_ms AS lastSeenAtMs,
        expires_at_ms AS expiresAtMs
      FROM asset_session_refs
      ORDER BY session_id ASC, asset_kind ASC, asset_id ASC, ref_kind ASC
    `).all() as AssetSessionRef[];
    return rows;
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{ rows: AssetSessionRef[]; total: number; offset: number; limit: number }> {
    const db = await this.getReadyDb();
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
    const totalRow = db.prepare("SELECT COUNT(*) AS count FROM asset_session_refs").get() as { count: number };
    const rows = db.prepare(`
      SELECT
        asset_kind AS assetKind,
        asset_id AS assetId,
        session_id AS sessionId,
        ref_kind AS refKind,
        created_at_ms AS createdAtMs,
        last_seen_at_ms AS lastSeenAtMs,
        expires_at_ms AS expiresAtMs
      FROM asset_session_refs
      ORDER BY last_seen_at_ms DESC, session_id ASC, asset_kind ASC, asset_id ASC, ref_kind ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as AssetSessionRef[];
    return { rows, total: totalRow.count, offset, limit };
  }

  async listReferencedAssetIds(assetKind: AssetKind): Promise<Set<string>> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT DISTINCT asset_id AS assetId
      FROM asset_session_refs
      WHERE asset_kind = ?
    `).all(assetKind) as Array<{ assetId: string }>;
    return new Set(rows.map((row) => row.assetId));
  }

  async removeRefsForAsset(assetKind: AssetKind, assetId: string): Promise<number> {
    const normalizedAssetId = normalizeId(assetId);
    const db = await this.getReadyDb();
    const result = db.prepare(`
      DELETE FROM asset_session_refs
      WHERE asset_kind = ? AND asset_id = ?
    `).run(assetKind, normalizedAssetId);
    return result.changes;
  }

  private insertRefs(db: SqliteDatabase, refs: AssetSessionRef[]): void {
    const insert = db.prepare(`
      INSERT INTO asset_session_refs (
        asset_kind,
        asset_id,
        session_id,
        ref_kind,
        created_at_ms,
        last_seen_at_ms,
        expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_kind, asset_id, session_id, ref_kind) DO UPDATE SET
        last_seen_at_ms = excluded.last_seen_at_ms,
        expires_at_ms = excluded.expires_at_ms
    `);
    for (const ref of refs) {
      insert.run(
        ref.assetKind,
        normalizeId(ref.assetId),
        normalizeId(ref.sessionId),
        normalizeId(ref.refKind),
        ref.createdAtMs,
        ref.lastSeenAtMs,
        ref.expiresAtMs
      );
    }
  }

  private async getReadyDb(): Promise<SqliteDatabase> {
    await this.assetsDatabase.init();
    return this.assetsDatabase.getDb();
  }
}

function normalizeId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error("asset lifecycle id is required");
  }
  return normalized;
}

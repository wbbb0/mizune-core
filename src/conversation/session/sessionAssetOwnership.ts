import { assertIndexExists, assertTableColumns, type SqliteDatabase, type SqliteTableGroupDefinition } from "#data/sqlite/sqliteService.ts";
import type { AssetReference } from "#data/assets/sessionAssetReferences.ts";

export interface SessionAssetOwner {
  kind: "session" | "snapshot";
  id: string;
  sessionId: string;
}

/** Call in the same transaction that writes the owning session or snapshot. */
export function replaceSessionAssetOwnership(db: SqliteDatabase, owner: SessionAssetOwner, references: Iterable<AssetReference>): void {
  db.prepare(`INSERT INTO session_asset_owners (owner_kind, owner_id, session_id)
    VALUES (?, ?, ?) ON CONFLICT(owner_kind, owner_id) DO UPDATE SET session_id = excluded.session_id
    WHERE session_asset_owners.session_id != excluded.session_id`)
    .run(owner.kind, owner.id, owner.sessionId);
  const next = new Map<string, AssetReference>();
  for (const reference of references) next.set(JSON.stringify([reference.assetKind, reference.assetId]), reference);
  const remove = db.prepare(`DELETE FROM session_owned_asset_refs
    WHERE owner_kind = ? AND owner_id = ? AND asset_kind = ? AND asset_id = ?`);
  for (const reference of listOwnedSessionAssetReferences(db, owner)) {
    if (!next.delete(JSON.stringify([reference.assetKind, reference.assetId]))) {
      remove.run(owner.kind, owner.id, reference.assetKind, reference.assetId);
    }
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO session_owned_asset_refs (owner_kind, owner_id, asset_kind, asset_id)
    VALUES (?, ?, ?, ?)`);
  for (const reference of next.values()) insert.run(owner.kind, owner.id, reference.assetKind, reference.assetId);
}

export function removeSessionAssetOwnership(db: SqliteDatabase, kind: SessionAssetOwner["kind"], id: string): void {
  db.prepare("DELETE FROM session_asset_owners WHERE owner_kind = ? AND owner_id = ?").run(kind, id);
}

export function listOwnedSessionAssetReferences(db: SqliteDatabase, owner?: Pick<SessionAssetOwner, "kind" | "id">): AssetReference[] {
  return owner
    ? db.prepare(`SELECT asset_kind AS assetKind, asset_id AS assetId FROM session_owned_asset_refs
        WHERE owner_kind = ? AND owner_id = ? ORDER BY asset_kind, asset_id`).all(owner.kind, owner.id) as AssetReference[]
    : db.prepare(`SELECT DISTINCT asset_kind AS assetKind, asset_id AS assetId FROM session_owned_asset_refs
        ORDER BY asset_kind, asset_id`).all() as AssetReference[];
}

export const SESSION_ASSET_OWNERSHIP_TABLE_GROUP: SqliteTableGroupDefinition = {
  groupId: "sessions.asset_ownership",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  ownedTables: ["session_owned_asset_refs", "session_asset_owners"],
  ownedIndexes: ["idx_session_asset_owners_session", "idx_session_owned_asset_refs_asset"],
  createSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_asset_owners (
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('session', 'snapshot')),
      owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
      session_id TEXT NOT NULL CHECK (length(trim(session_id)) > 0),
      PRIMARY KEY (owner_kind, owner_id)
    );
    CREATE TABLE IF NOT EXISTS session_owned_asset_refs (
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL CHECK (asset_kind IN ('chat_file', 'audio', 'comfy_task', 'content_safety_audit')),
      asset_id TEXT NOT NULL CHECK (length(trim(asset_id)) > 0),
      PRIMARY KEY (owner_kind, owner_id, asset_kind, asset_id),
      FOREIGN KEY (owner_kind, owner_id) REFERENCES session_asset_owners(owner_kind, owner_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_asset_owners_session ON session_asset_owners(session_id, owner_kind, owner_id);
    CREATE INDEX IF NOT EXISTS idx_session_owned_asset_refs_asset ON session_owned_asset_refs(asset_kind, asset_id);`);
  },
  validateSchema(db) {
    assertTableColumns(db, "session_asset_owners", { owner_kind: "TEXT", owner_id: "TEXT", session_id: "TEXT" });
    assertTableColumns(db, "session_owned_asset_refs", { owner_kind: "TEXT", owner_id: "TEXT", asset_kind: "TEXT", asset_id: "TEXT" });
    assertIndexExists(db, "idx_session_asset_owners_session");
    assertIndexExists(db, "idx_session_owned_asset_refs_asset");
  }
};

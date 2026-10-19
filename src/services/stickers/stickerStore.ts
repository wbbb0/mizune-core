import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AssetsDatabase } from "#data/assets/assetsDatabase.ts";

const shortText = z.string().trim().max(300);
const tags = z.array(z.string().trim().min(1).max(60)).max(8);
export const stickerMetadataSchema = z.object({
  description: shortText.min(1),
  visibleText: shortText,
  situations: tags,
  emotions: tags,
  styles: tags,
  intensity: z.enum(["轻", "中", "强"]),
  caution: shortText,
  notes: shortText
}).strict();
export type StickerMetadata = z.infer<typeof stickerMetadataSchema>;
export const stickerUsagePatchSchema = stickerMetadataSchema.omit({ description: true, visibleText: true }).partial().strict();
export type StickerUsagePatch = z.infer<typeof stickerUsagePatchSchema>;
export interface StickerRecord {
  id: string;
  fileId: string;
  contentHash: string;
  metadata: StickerMetadata;
  locked: boolean;
  revision: number;
  useCount: number;
  lastUsedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  reason: string;
}
interface Row {
  id: string; file_id: string; content_hash: string; metadata_json: string;
  locked: number; revision: number; use_count: number; last_used_at_ms: number | null;
  created_at_ms: number; updated_at_ms: number; reason: string;
}
function record(row: Row): StickerRecord {
  return {
    id: row.id, fileId: row.file_id, contentHash: row.content_hash,
    metadata: stickerMetadataSchema.parse(JSON.parse(row.metadata_json)), locked: row.locked === 1,
    revision: row.revision, useCount: row.use_count, lastUsedAtMs: row.last_used_at_ms,
    createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, reason: row.reason
  };
}
export class StickerStore {
  constructor(private readonly database: AssetsDatabase, private readonly capacity: () => number) {}
  list(): StickerRecord[] {
    return (this.database.getDb().prepare("SELECT * FROM stickers ORDER BY id").all() as Row[]).map(record);
  }
  get(id: string): StickerRecord {
    const row = this.database.getDb().prepare("SELECT * FROM stickers WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error("表情不存在，请重新检索。");
    return record(row);
  }
  findHash(hash: string): StickerRecord | undefined {
    const row = this.database.getDb().prepare("SELECT * FROM stickers WHERE content_hash = ?").get(hash) as Row | undefined;
    return row ? record(row) : undefined;
  }
  assertWritable(id: string, revision: number): StickerRecord {
    const item = this.get(id);
    if (item.locked) throw new Error("该表情已锁定，不能修改、删除或替换。");
    this.assertRevision(item, revision);
    return item;
  }
  assertCanAdd(replace?: { id: string; revision: number }): void {
    if (replace) this.assertWritable(replace.id, replace.revision);
    else if (this.list().length >= this.capacity()) throw new Error("表情库已满，请检索后明确指定替换对象及其版本，或放弃收藏。");
  }
  add(input: { fileId: string; contentHash: string; metadata: StickerMetadata; reason: string; replace?: { id: string; revision: number } }): { item: StickerRecord; duplicate: boolean } {
    const metadata = stickerMetadataSchema.parse(input.metadata);
    const reason = shortText.min(1).parse(input.reason);
    const db = this.database.getDb();
    return db.transaction(() => {
      const duplicate = this.findHash(input.contentHash);
      if (duplicate) return { item: duplicate, duplicate: true };
      this.assertCanAdd(input.replace);
      if (input.replace) db.prepare("DELETE FROM stickers WHERE id = ?").run(input.replace.id);
      const id = `sticker_${randomUUID()}`;
      const now = Date.now();
      db.prepare(`INSERT INTO stickers (id, file_id, content_hash, metadata_json, created_at_ms, updated_at_ms, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.fileId, input.contentHash, JSON.stringify(metadata), now, now, reason);
      return { item: this.get(id), duplicate: false };
    }).immediate();
  }
  update(id: string, revision: number, patch: StickerUsagePatch, reason: string, observed?: StickerMetadata): StickerRecord {
    const checked = stickerUsagePatchSchema.parse(patch);
    const db = this.database.getDb();
    return db.transaction(() => {
      const item = this.assertWritable(id, revision);
      const metadata = stickerMetadataSchema.parse({ ...item.metadata, ...observed, ...checked });
      db.prepare("UPDATE stickers SET metadata_json = ?, revision = revision + 1, updated_at_ms = ?, reason = ? WHERE id = ?")
        .run(JSON.stringify(metadata), Date.now(), shortText.min(1).parse(reason), id);
      return this.get(id);
    }).immediate();
  }
  remove(id: string, revision: number, reason: string): void {
    shortText.min(1).parse(reason);
    const db = this.database.getDb();
    db.transaction(() => {
      this.assertWritable(id, revision);
      db.prepare("DELETE FROM stickers WHERE id = ?").run(id);
    }).immediate();
  }
  setLocked(id: string, revision: number, locked: boolean): StickerRecord {
    const db = this.database.getDb();
    return db.transaction(() => {
      this.assertRevision(this.get(id), revision);
      db.prepare("UPDATE stickers SET locked = ?, revision = revision + 1, updated_at_ms = ? WHERE id = ?")
        .run(locked ? 1 : 0, Date.now(), id);
      return this.get(id);
    }).immediate();
  }
  markUsed(id: string): void {
    this.database.getDb().prepare("UPDATE stickers SET use_count = use_count + 1, last_used_at_ms = ? WHERE id = ?").run(Date.now(), id);
  }
  private assertRevision(item: StickerRecord, revision: number): void {
    if (item.revision !== revision) throw new Error("表情资料已变化，请重新检索后使用最新版本。");
  }
}

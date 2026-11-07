import type { AssetsDatabase } from "./assetsDatabase.ts";
import type { AssetReference } from "./sessionAssetReferences.ts";

/** Call inside the shared ownership/GC boundary before committing a new snapshot. */
export async function assertAssetReferencesExist(database: AssetsDatabase, references: readonly AssetReference[]): Promise<void> {
  if (references.length === 0) return;
  await database.init();
  const db = database.getDb();
  const exists = {
    chat_file: db.prepare("SELECT 1 FROM chat_files WHERE file_id = @assetId OR file_ref = @assetId LIMIT 1"),
    audio: db.prepare("SELECT 1 FROM audio_files WHERE id = @assetId"),
    comfy_task: db.prepare("SELECT 1 FROM comfy_tasks WHERE id = @assetId"),
    content_safety_audit: db.prepare("SELECT 1 FROM content_safety_audits WHERE key = @assetId")
  };
  const checked = new Set<string>();
  for (const reference of references) {
    const key = JSON.stringify([reference.assetKind, reference.assetId]);
    if (checked.has(key)) continue;
    checked.add(key);
    if (!exists[reference.assetKind].get({ assetId: reference.assetId })) {
      throw new Error(`无法存档：引用的资产不存在（${reference.assetKind}: ${reference.assetId}）`);
    }
  }
}

import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { ContextStore } from "./contextStore.ts";
import type { ContextSearchDocument } from "./contextTypes.ts";
import { OramaContextIndex } from "./oramaContextIndex.ts";

type SnapshotEntry = { userId: string; profileId: string; signature: string; snapshot: Promise<OramaContextIndex> };

const DEFAULT_MAX_SNAPSHOTS = 64;

/** SQLite owns validity. This cache retains only a bounded set of immutable search snapshots. */
export class ContextIndexCache {
  private readonly snapshots: LRUCache<string, SnapshotEntry>;

  constructor(private readonly store: ContextStore, maxSnapshots = DEFAULT_MAX_SNAPSHOTS) {
    this.snapshots = new LRUCache({ max: Math.max(1, Math.floor(maxSnapshots)) });
  }

  get(userId: string, profileId: string): Promise<OramaContextIndex> {
    const documents = this.store.listUserSearchDocuments(userId);
    const hashes = new Map(documents.map((document) => [document.itemId, document.embeddingTextHash]));
    const metadata = this.store.getItemEmbeddingMetadata(documents.map((document) => document.itemId), profileId, hashes);
    const indexedDocuments = documents.filter((document) => metadata.has(document.itemId))
      .sort((a, b) => a.itemId.localeCompare(b.itemId));
    // Usage counters do not affect search. All actual document fields and persisted vector digests do.
    const signature = createHash("sha256").update(JSON.stringify(indexedDocuments.map(({ lastRetrievedAt: _usage, ...document }) => [
      document, metadata.get(document.itemId)
    ]))).digest("base64url");
    const key = JSON.stringify([userId, profileId]);
    const existing = this.snapshots.get(key);
    if (existing?.signature === signature) return existing.snapshot;

    const snapshot = this.build(profileId, indexedDocuments, hashes);
    const entry: SnapshotEntry = { userId, profileId, signature, snapshot };
    this.snapshots.set(key, entry);
    // A failed build must be retryable; an older build must not replace a newer entry.
    void snapshot.catch(() => {
      if (this.snapshots.get(key) === entry) this.snapshots.delete(key);
    });
    return snapshot;
  }

  reset(userId?: string): number {
    // 返回被重置的用户数；同一用户的多个 profile 共享一次重置计数。
    const removedUsers = new Set<string>();
    for (const [key, entry] of this.snapshots) {
      if (userId !== undefined && entry.userId !== userId) continue;
      this.snapshots.delete(key);
      removedUsers.add(entry.userId);
    }
    return removedUsers.size;
  }

  private async build(profileId: string, documents: ContextSearchDocument[], hashes: Map<string, string>): Promise<OramaContextIndex> {
    const vectors = this.store.getItemEmbeddings(documents.map((document) => document.itemId), profileId, hashes);
    return OramaContextIndex.build(documents.flatMap((document) => {
      const embedding = vectors.get(document.itemId);
      return embedding ? [{ ...document, embedding }] : [];
    }));
  }
}

import { createHash } from "node:crypto";
import type { ContextStore } from "./contextStore.ts";
import type { ContextSearchDocument } from "./contextTypes.ts";
import { OramaContextIndex } from "./oramaContextIndex.ts";

type SnapshotEntry = { signature: string; snapshot: Promise<OramaContextIndex> };

/** SQLite owns validity. This cache only retains immutable, profile-specific search snapshots. */
export class ContextIndexCache {
  private readonly users = new Map<string, Map<string, SnapshotEntry>>();

  constructor(private readonly store: ContextStore) {}

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
    let profiles = this.users.get(userId);
    if (!profiles) {
      profiles = new Map();
      this.users.set(userId, profiles);
    }
    const existing = profiles.get(profileId);
    if (existing?.signature === signature) return existing.snapshot;
    const snapshot = this.build(profileId, indexedDocuments, hashes);
    const entry = { signature, snapshot };
    profiles.set(profileId, entry);
    // A failed build must be retryable; an older build must not replace a newer entry.
    void snapshot.catch(() => {
      if (profiles.get(profileId) === entry) profiles.delete(profileId);
    });
    return snapshot;
  }

  reset(userId?: string): number {
    if (userId) return this.users.delete(userId) ? 1 : 0;
    const count = this.users.size;
    this.users.clear();
    return count;
  }

  private async build(profileId: string, documents: ContextSearchDocument[], hashes: Map<string, string>): Promise<OramaContextIndex> {
    const vectors = this.store.getItemEmbeddings(documents.map((document) => document.itemId), profileId, hashes);
    return OramaContextIndex.build(documents.flatMap((document) => {
      const embedding = vectors.get(document.itemId);
      return embedding ? [{ ...document, embedding }] : [];
    }));
  }
}

import { api } from "./client";

export type ContextScope = "session" | "user" | "global" | "toolset" | "mode";
export type ContextSourceType = "chunk" | "summary" | "fact" | "rule";
export type ContextRetrievalPolicy = "always" | "search" | "never";
export type ContextItemStatus = "active" | "archived" | "deleted" | "superseded";
export type ContextSensitivity = "normal" | "private" | "secret";

export interface ContextManagementItem {
  itemId: string;
  scope: ContextScope;
  sourceType: ContextSourceType;
  retrievalPolicy: ContextRetrievalPolicy;
  status: ContextItemStatus;
  userId?: string;
  sessionId?: string;
  toolsetId?: string;
  modeId?: string;
  title?: string;
  text: string;
  kind?: string;
  source?: string;
  importance?: number;
  pinned: boolean;
  sensitivity: ContextSensitivity;
  createdAt: number;
  updatedAt: number;
  validTo?: number;
  supersededBy?: string;
  lastRetrievedAt?: number;
}

export interface ContextItemFilters {
  userId?: string;
  scope?: ContextScope | "";
  sourceType?: ContextSourceType | "";
  status?: ContextItemStatus | "";
  limit?: number;
  offset?: number;
}

export interface ContextStatus {
  store: {
    available: boolean;
    dbPath: string;
    disabledReason?: string;
  };
  embedding: {
    configured: boolean;
    modelRefs: string[];
    timeoutMs: number;
    textPreprocessVersion: string;
    chunkerVersion: string;
  };
  stats: {
    rawMessages: number;
    contextItems: number;
    embeddings: number;
    sqliteBytes: number;
  };
  lastRetrieval: {
    userId: string;
    queryText: string;
    embeddingProfileId?: string;
    candidateCount: number;
    indexedCount: number;
    selectedCount: number;
    droppedCount: number;
    error?: string;
    createdAt: number;
  } | null;
}

export interface ContextItemPatch {
  title?: string | null;
  text?: string;
  retrievalPolicy?: ContextRetrievalPolicy;
  status?: ContextItemStatus;
  sensitivity?: ContextSensitivity;
  importance?: number | null;
  pinned?: boolean;
  validTo?: number | null;
  supersededBy?: string | null;
}

function appendQuery(params: URLSearchParams, key: string, value: string | number | undefined): void {
  if (value === undefined || value === "") {
    return;
  }
  params.set(key, String(value));
}

export const contextApi = {
  getStatus(): Promise<ContextStatus> {
    return api.get("/api/context/status");
  },
  listItems(filters: ContextItemFilters = {}): Promise<{ items: ContextManagementItem[]; total: number }> {
    const params = new URLSearchParams();
    appendQuery(params, "userId", filters.userId?.trim());
    appendQuery(params, "scope", filters.scope);
    appendQuery(params, "sourceType", filters.sourceType);
    appendQuery(params, "status", filters.status);
    appendQuery(params, "limit", filters.limit);
    appendQuery(params, "offset", filters.offset);
    const query = params.toString();
    return api.get(`/api/context/items${query ? `?${query}` : ""}`);
  },
  deleteItem(itemId: string): Promise<{ deleted: boolean }> {
    return api.delete(`/api/context/items/${encodeURIComponent(itemId)}`);
  },
  setPinned(itemId: string, pinned: boolean): Promise<{ updated: boolean }> {
    return api.patch(`/api/context/items/${encodeURIComponent(itemId)}/pinned`, { pinned });
  },
  updateItem(itemId: string, patch: ContextItemPatch): Promise<{ updated: boolean; item: ContextManagementItem | null }> {
    return api.patch(`/api/context/items/${encodeURIComponent(itemId)}`, patch);
  },
  bulkDelete(filters: ContextItemFilters): Promise<{ deletedCount: number }> {
    return api.post("/api/context/items/bulk-delete", filters);
  },
  exportItems(filters: ContextItemFilters): Promise<{ count: number; jsonl: string }> {
    return api.post("/api/context/items/export", filters);
  },
  importItems(jsonl: string): Promise<{ importedCount: number; skippedCount: number }> {
    return api.post("/api/context/items/import", { jsonl });
  },
  compactUser(input: { userId: string; olderThanDays: number; maxSourceChunks?: number }): Promise<{ compactedCount: number; summaryItemId?: string }> {
    return api.post("/api/context/maintenance/compact-user", input);
  },
  sweepDeleted(input: { deletedBeforeDays: number }): Promise<{ deletedCount: number }> {
    return api.post("/api/context/maintenance/sweep-deleted", input);
  },
  clearEmbeddings(filters: ContextItemFilters): Promise<{ deletedCount: number }> {
    return api.post("/api/context/maintenance/clear-embeddings", filters);
  },
  resetIndex(input: { userId?: string } = {}): Promise<{ resetCount: number }> {
    return api.post("/api/context/maintenance/reset-index", input);
  },
  rebuildIndex(input: { userId?: string; forceReembed?: boolean; embeddingBatchSize?: number } = {}): Promise<{
    userCount: number;
    embeddedCount: number;
    indexedCount: number;
    skippedCount: number;
    errors: Array<{ userId: string; error: string }>;
  }> {
    return api.post("/api/context/maintenance/rebuild-index", input);
  }
};

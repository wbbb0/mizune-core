import { api } from "./client";
import type { SchemaMeta, UiNode } from "@workbench-kit/vue-resource-editor";

export type DataResourceShape = "singleton" | "collection" | "log" | "file" | "directory";
export type DataResourceDurability = "source_of_truth" | "cache" | "derived" | "ephemeral";

export interface DataResourceSummary {
  key: string;
  title: string;
  description?: string;
  shape: DataResourceShape;
  editable: boolean;
  durability: DataResourceDurability;
  storage: {
    kind: "sqlite" | "file";
    database?: "state" | "sessions" | "assets" | "context";
    tableGroup?: string;
    tables?: string[];
    path?: string;
  };
  schemaMeta?: SchemaMeta;
  rowSchemaMeta?: SchemaMeta;
  uiTree?: UiNode;
  rowUiTree?: UiNode;
  rowIdentity?: {
    fields: string[];
    encode: "single" | "json_base64url";
  };
  export?: {
    enabled: boolean;
    fileName: string;
    format: "json" | "jsonl" | "yaml" | "csv" | "markdown";
  };
}

export interface DirectoryItem {
  key: string;
  title: string;
  path?: string;
  size?: number;
  updatedAt?: number;
}

export type DataResource =
  | (DataResourceSummary & { shape: "file"; value: unknown })
  | (DataResourceSummary & { shape: "singleton"; value: unknown })
  | (DataResourceSummary & { shape: "directory"; items: DirectoryItem[] })
  | (DataResourceSummary & { shape: "collection" | "log" });

export interface DataResourceItem {
  resourceKey: string;
  key: string;
  title: string;
  path?: string;
  size?: number;
  updatedAt?: number;
  value: unknown;
}

export interface DataResourceRowsQuery {
  offset?: number;
  limit?: number;
  sort?: string;
  filters?: Record<string, unknown>;
}

export interface DataResourceRowsResult {
  rows: unknown[];
  total?: number;
  offset: number;
  limit: number;
}

export const dataApi = {
  list(): Promise<{ resources: DataResourceSummary[] }> {
    return api.get("/api/data/registry/resources");
  },
  get(key: string): Promise<{ resource: DataResource }> {
    return api.get(`/api/data/registry/resources/${encodeURIComponent(key)}`);
  },
  patchSingleton(key: string, value: unknown): Promise<{ resource: DataResourceSummary; value: unknown }> {
    return api.patch(`/api/data/registry/resources/${encodeURIComponent(key)}`, { value });
  },
  getItem(resourceKey: string, itemKey: string): Promise<{ item: DataResourceItem }> {
    return api.get(`/api/data/registry/resources/${encodeURIComponent(resourceKey)}/items/${encodeURIComponent(itemKey)}`);
  },
  listRows(resourceKey: string, query: DataResourceRowsQuery = {}): Promise<DataResourceRowsResult> {
    const params = new URLSearchParams();
    if (query.offset != null) params.set("offset", String(query.offset));
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.sort) params.set("sort", query.sort);
    if (query.filters) params.set("filters", JSON.stringify(query.filters));
    const suffix = params.toString() ? `?${params}` : "";
    return api.get(`/api/data/registry/resources/${encodeURIComponent(resourceKey)}/rows${suffix}`);
  },
  createRow(resourceKey: string, value: unknown): Promise<{ row: unknown }> {
    return api.post(`/api/data/registry/resources/${encodeURIComponent(resourceKey)}/rows`, { value });
  },
  deleteRow(resourceKey: string, rowId: string): Promise<{ ok: true }> {
    return api.delete(`/api/data/registry/resources/${encodeURIComponent(resourceKey)}/rows/${encodeURIComponent(rowId)}`);
  }
};

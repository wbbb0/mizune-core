import { api } from "./client";

export interface DataResourceSummary {
  key: string;
  title: string;
  kind: "single_json" | "directory_json";
}

export interface DirectoryItem {
  key: string;
  title: string;
  path: string;
  size: number;
  updatedAt: number;
}

export type DataResource =
  | { key: string; title: string; kind: "single_json"; path: string; value: unknown }
  | { key: string; title: string; kind: "directory_json"; path: string; items: DirectoryItem[] };

export interface DataResourceItem {
  resourceKey: string;
  key: string;
  title: string;
  path: string;
  size: number;
  updatedAt: number;
  value: unknown;
}

export const dataApi = {
  list(): Promise<{ resources: DataResourceSummary[] }> {
    return api.get("/api/data/resources");
  },
  get(key: string): Promise<{ resource: DataResource }> {
    return api.get(`/api/data/resources/${encodeURIComponent(key)}`);
  },
  getItem(resourceKey: string, itemKey: string): Promise<{ item: DataResourceItem }> {
    return api.get(`/api/data/resources/${encodeURIComponent(resourceKey)}/items/${encodeURIComponent(itemKey)}`);
  }
};

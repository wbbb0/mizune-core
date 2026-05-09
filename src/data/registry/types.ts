export type DataResourceShape = "singleton" | "collection" | "log" | "file" | "directory";

export type DataResourceDurability = "source_of_truth" | "cache" | "derived" | "ephemeral";

export interface DataResourceStorage {
  kind: "sqlite" | "file";
  database?: "state" | "sessions" | "assets" | "context";
  tableGroup?: string;
  tables?: string[];
  path?: string;
}

export interface DataResourceIdentity {
  fields: string[];
  encode: "single" | "json_base64url";
}

export interface DataResourceRowOperations {
  get: boolean;
  create: boolean;
  patch: boolean;
  delete: boolean;
}

export interface DataResourceExportDefinition {
  enabled: boolean;
  fileName: string;
  format: "json" | "jsonl" | "yaml" | "csv" | "markdown";
}

export interface DataResourceSummary {
  key: string;
  title: string;
  description?: string;
  shape: DataResourceShape;
  editable: boolean;
  durability: DataResourceDurability;
  storage: DataResourceStorage;
  schemaMeta?: unknown;
  rowSchemaMeta?: unknown;
  uiTree?: unknown;
  rowUiTree?: unknown;
  rowIdentity?: DataResourceIdentity;
  rowOperations?: DataResourceRowOperations;
  export?: DataResourceExportDefinition;
}

export interface DataResourceListRowsInput {
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

export interface DataResourceRowPatchInput {
  patch: Record<string, unknown>;
  revision?: string | number | undefined;
  updatedAt?: string | number | undefined;
}

export interface DataResourceDirectoryItem {
  key: string;
  title: string;
  path?: string;
  size?: number;
  updatedAt?: number;
}

export interface SingletonDataResourceAdapter {
  get: () => Promise<unknown>;
  patch?: (value: unknown) => Promise<unknown>;
}

export interface CollectionDataResourceAdapter {
  listRows: (input: DataResourceListRowsInput) => Promise<DataResourceRowsResult>;
  getRow?: (rowId: string) => Promise<unknown | null>;
  createRow?: (value: unknown) => Promise<unknown>;
  patchRow?: (rowId: string, input: DataResourceRowPatchInput) => Promise<unknown>;
  deleteRow?: (rowId: string) => Promise<void>;
}

export interface FileDataResourceAdapter {
  get: () => Promise<unknown>;
}

export interface DirectoryDataResourceAdapter {
  listItems: () => Promise<DataResourceDirectoryItem[]>;
  getItem?: (itemKey: string) => Promise<unknown | null>;
}

export type DataResourceAdapter =
  | SingletonDataResourceAdapter
  | CollectionDataResourceAdapter
  | FileDataResourceAdapter
  | DirectoryDataResourceAdapter;

export interface DataResourceDefinition {
  key: string;
  title: string;
  description?: string;
  shape: DataResourceShape;
  editable: boolean;
  durability: DataResourceDurability;
  storage: DataResourceStorage;
  schemaMeta?: unknown;
  rowSchemaMeta?: unknown;
  uiTree?: unknown;
  rowUiTree?: unknown;
  rowIdentity?: DataResourceIdentity;
  export?: DataResourceExportDefinition;
  adapter: DataResourceAdapter;
}

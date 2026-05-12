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

export interface DataResourceNavigation {
  hiddenFromList?: boolean;
  parentResourceKey?: string;
}

export interface DataResourceModelColumn {
  key: string;
  title?: string;
  type: "text" | "integer" | "real" | "boolean" | "json";
  nullable?: boolean;
  role?: "id" | "title" | "subtitle" | "badge" | "time" | "payload" | "status";
  primary?: boolean;
  listWidth?: "xs" | "sm" | "md" | "lg" | "xl" | (string & {});
  hidden?: boolean;
}

export interface DataResourceModelChild {
  resourceKey: string;
  title: string;
  parentField: string;
  childField: string;
}

export interface DataResourceModelList {
  titleColumn?: string;
  fallbackTitleColumn?: string;
  subtitleColumns?: string[];
  badgeColumns?: string[];
  timeColumn?: string;
  columns?: string[];
}

export interface DataResourceModelDetail {
  columns?: string[];
  payloadColumns?: string[];
}

export interface DataResourceModel {
  kind: "table";
  table: string;
  primaryKey: string[];
  columns: DataResourceModelColumn[];
  defaultSort?: Array<{ column: string; direction: "asc" | "desc" }>;
  list?: DataResourceModelList;
  detail?: DataResourceModelDetail;
  children?: DataResourceModelChild[];
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
  model?: DataResourceModel;
  rowIdentity?: DataResourceIdentity;
  rowOperations?: DataResourceRowOperations;
  navigation?: DataResourceNavigation;
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
  exportRows?: (input: DataResourceListRowsInput) => Promise<DataResourceRowsResult>;
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
  model?: DataResourceModel;
  rowIdentity?: DataResourceIdentity;
  navigation?: DataResourceNavigation;
  export?: DataResourceExportDefinition;
  adapter: DataResourceAdapter;
}

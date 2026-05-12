import type { DataResource, DataResourceModelColumn } from "@/api/data";

export type DataModelDetailEntry = {
  column: DataResourceModelColumn;
  value: unknown;
};

export function getModelListColumns(target: DataResource | null | undefined): DataResourceModelColumn[] {
  if (!target?.model) return [];
  const primaryColumns = target.model.columns.filter((column) => column.primary && !column.hidden);
  const preferred = primaryColumns.length > 0
    ? primaryColumns.map((column) => column.key)
    : target.model.list?.columns?.length
      ? target.model.list.columns
      : target.model.columns.filter((column) => !column.hidden && column.role !== "payload").slice(0, 6).map((column) => column.key);
  return preferred
    .map((key) => target.model?.columns.find((column) => column.key === key))
    .filter((column): column is DataResourceModelColumn => Boolean(column));
}

export function getModelDetailEntries(target: DataResource | null | undefined, row: Record<string, unknown> | null): DataModelDetailEntry[] {
  if (!target?.model || !row) return [];
  const detailColumns = target.model.detail?.columns?.length
    ? target.model.detail.columns
    : target.model.columns.filter((column) => !column.hidden && column.role !== "payload").map((column) => column.key);
  const keys = [...new Set([...detailColumns, ...(target.model.detail?.payloadColumns ?? [])])];
  return keys
    .map((key) => {
      const column = target.model?.columns.find((item) => item.key === key);
      return column ? { column, value: row[key] } : null;
    })
    .filter((entry): entry is DataModelDetailEntry => Boolean(entry));
}

export function rowText(value: unknown): string {
  return value == null || value === "" ? "-" : String(value);
}

export function formatModelCell(value: unknown, type: string | undefined, formatTime: (ms: number | undefined) => string): string {
  if (type === "json") return summarizeValue(value);
  if (type === "boolean") return value ? "yes" : "no";
  if (type === "integer" && typeof value === "number" && value > 10_000_000_000) return formatTime(value);
  return rowText(value);
}

export function summarizeValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.length > 140 ? `${value.slice(0, 140)}...` : value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : typeof record.summary === "string"
          ? record.summary
          : "";
    if (text) return text.length > 140 ? `${text.slice(0, 140)}...` : text;
  }
  const serialized = JSON.stringify(value);
  return serialized.length > 140 ? `${serialized.slice(0, 140)}...` : serialized;
}

export function modelRowId(row: unknown, resource: DataResource | null | undefined): string {
  if (!resource?.model || row == null || typeof row !== "object" || Array.isArray(row)) return "";
  return resource.model.primaryKey
    .map((key) => (row as Record<string, unknown>)[key])
    .map((value) => rowText(value))
    .join(":");
}

export function modelRowKey(row: unknown, resource: DataResource | null | undefined): string {
  return modelRowId(row, resource) || JSON.stringify(row);
}

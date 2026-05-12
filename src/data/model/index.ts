import type { DataResourceModel, DataResourceModelChild, DataResourceModelDetail, DataResourceModelList } from "#data/registry/types.ts";
import { assertIndexExists, assertTableColumns, type SqliteDatabase, type SqliteTableGroupDefinition } from "#data/sqlite/sqliteService.ts";

/**
 * Logical SQLite database handled by the data registry.
 *
 * This is a stable domain identifier, not a filesystem path. The runtime maps
 * the value to the corresponding SQLite service instance.
 */
export type DataModelDatabase = "state" | "sessions" | "assets" | "context";

/**
 * Declarative input for a native SQLite table exposed through the data registry.
 *
 * Use {@link defineTable} instead of constructing {@link DataTableModel}
 * directly. The helper adds the fixed `kind: "table"` discriminator while
 * preserving the table metadata for schema management and WebUI generation.
 */
export interface DataTableModelInput {
  /** Physical SQLite table name. */
  table: string;
  /**
   * Logical primary key column keys.
   *
   * These keys refer to {@link DataModelColumn.key}, not `storageName`.
   * The generated DDL maps them to physical names automatically.
   */
  primaryKey: string[];
  /** Ordered logical column definitions for storage, querying, and UI metadata. */
  columns: DataModelColumn[];
  /**
   * Additional unique constraints, expressed with logical column keys.
   *
   * Each nested array becomes one `UNIQUE (...)` table constraint.
   */
  unique?: string[][];
  /** Foreign key constraints, expressed with logical local column keys. */
  foreignKeys?: DataModelForeignKey[];
  /** SQLite indexes to create and validate for this table. */
  indexes?: DataModelIndex[];
  /**
   * Default ordering for list queries.
   *
   * Primary key columns are appended as deterministic tiebreakers.
   */
  defaultSort?: DataResourceModel["defaultSort"];
  /**
   * Optional list-view metadata.
   *
   * New models should prefer `primary: true` on columns for table-list display.
   * `list.columns` remains useful as an explicit override/fallback.
   */
  list?: DataResourceModelList;
  /** Optional record-detail metadata for generated data management UI. */
  detail?: DataResourceModelDetail;
  /** Child table relations shown by the generated detail UI. */
  children?: DataResourceModelChild[];
}

/**
 * Normalized table model used by schema creation, migration, validation, and
 * data registry list queries.
 */
export interface DataTableModel extends DataResourceModel {
  /** Discriminator for registry model consumers. */
  kind: "table";
  /** Ordered logical column definitions. */
  columns: DataModelColumn[];
  /** Additional unique constraints, expressed with logical column keys. */
  unique?: string[][];
  /** Foreign key constraints for generated DDL. */
  foreignKeys?: DataModelForeignKey[];
  /** SQLite index definitions for generated DDL and validation. */
  indexes?: DataModelIndex[];
}

/**
 * A coherent data-model domain backed by one SQLite database and one table group.
 *
 * The domain is the unit passed to schema creation/migration and converted into
 * sqlite table-group definitions for the existing `SqliteService`.
 */
export interface DataDomainModel {
  /** Runtime database to install this domain into. */
  database: DataModelDatabase;
  /** SQLite table group id used for versioning and reset policy tracking. */
  tableGroup: string;
  /** Schema version recorded by the SQLite table-group manager. Defaults to 1. */
  schemaVersion?: number;
  /** Reset policy used when schema validation fails. */
  resetPolicy?: SqliteTableGroupDefinition["resetPolicy"];
  /** Tables keyed by data resource key or another stable domain-local name. */
  tables: Record<string, DataTableModel>;
}

/**
 * Logical column definition shared by SQLite schema management and generated UI.
 *
 * The `key` is the stable application-facing name. The optional `storageName`
 * is the physical SQLite column name when it differs from the logical key.
 */
export interface DataModelColumn {
  /** Stable logical column key used in TypeScript rows, filters, sort, and UI metadata. */
  key: string;
  /** Human-readable label for generated UI. Defaults to {@link key}. */
  title?: string;
  /** Logical value type. `json` columns are stored as TEXT and parsed on read. */
  type: "text" | "integer" | "real" | "boolean" | "json";
  /** Whether UI/API consumers should treat null as a valid value. */
  nullable?: boolean;
  /**
   * Semantic display role for generated UI.
   *
   * `payload` is intended for large structured content and is excluded from
   * default list columns. `time` integer values are formatted as timestamps.
   */
  role?: "id" | "title" | "subtitle" | "badge" | "time" | "payload" | "status";
  /**
   * Marks the column as important for table-list display.
   *
   * If any visible columns in a table have `primary: true`, the generated Data
   * page list shows only those columns. Other visible columns remain available
   * in record detail. Use this for ids, titles, status badges, timestamps, and
   * short operational fields; avoid marking raw JSON payloads as primary.
   */
  primary?: boolean;
  /**
   * Optional table-list column width.
   *
   * Presets map to conservative CSS grid tracks in the WebUI. Use a raw CSS
   * track string for uncommon cases, for example `"minmax(12rem, 1fr)"`.
   */
  listWidth?: "xs" | "sm" | "md" | "lg" | "xl" | (string & {});
  /** Hides the column from generated API row selection and generated UI. */
  hidden?: boolean;
  /** Physical SQLite column name. Defaults to {@link key}. */
  storageName?: string;
  /**
   * Storage strategy.
   *
   * Defaults to `physical`. `computed` columns are not included in DDL and must
   * provide `selectSql` if they should appear in list query results.
   */
  storage?: "physical" | "computed";
  /**
   * SQL expression used to select this column.
   *
   * Required for computed columns that should be returned by
   * {@link listDataModelRows}. The expression is inserted into a generated
   * `SELECT <expr> AS <key>` clause and should be trusted static SQL.
   */
  selectSql?: string;
  /** Adds `NOT NULL` to generated DDL for physical columns. */
  notNull?: boolean;
  /** Raw SQLite default expression, for example `"0"` or `"CURRENT_TIMESTAMP"`. */
  defaultSql?: string;
  /** Raw SQLite `CHECK (...)` expression without the surrounding keyword. */
  checkSql?: string;
}

/** Pagination and filter input for generated table list queries. */
export interface DataModelListRowsInput {
  /** Zero-based row offset. Values below 0 are normalized to 0. */
  offset?: number;
  /** Page size. Values are clamped to the range 1..500. Defaults to 100. */
  limit?: number;
  /**
   * Equality filters keyed by logical column key.
   *
   * Only scalar values on physical, non-json columns are accepted. Unsupported
   * filters are ignored rather than interpolated into SQL.
   */
  filters?: Record<string, unknown>;
}

/** Foreign key definition for generated table DDL. */
export interface DataModelForeignKey {
  /** Local logical column keys. */
  columns: string[];
  /** Referenced physical SQLite table name. */
  referencesTable: string;
  /** Referenced physical SQLite column names. */
  referencesColumns: string[];
  /** Optional SQLite `ON DELETE` action. */
  onDelete?: "CASCADE" | "RESTRICT" | "SET NULL" | "NO ACTION";
}

/** SQLite index definition for generated DDL and validation. */
export interface DataModelIndex {
  /** Physical SQLite index name. */
  name: string;
  /** Logical column keys to index. */
  columns: string[];
  /** Whether to create a unique index. */
  unique?: boolean;
}

/**
 * Defines a data-model domain.
 *
 * This helper intentionally returns the input unchanged; it exists to make call
 * sites self-documenting and to give TypeScript a stable inference point for
 * domain definitions.
 */
export function defineDataDomain(input: DataDomainModel): DataDomainModel {
  return input;
}

/**
 * Defines a native SQLite table model for schema management and generated UI.
 *
 * @example
 * ```ts
 * const sessions = defineTable({
 *   table: "sessions",
 *   primaryKey: ["sessionId"],
 *   columns: [
 *     textColumn("sessionId", { storageName: "session_id", notNull: true, primary: true }),
 *     textColumn("title", { nullable: true, role: "title", primary: true })
 *   ]
 * });
 * ```
 */
export function defineTable(input: DataTableModelInput): DataTableModel {
  return {
    kind: "table",
    table: input.table,
    primaryKey: input.primaryKey,
    columns: input.columns,
    ...(input.unique !== undefined ? { unique: input.unique } : {}),
    ...(input.foreignKeys !== undefined ? { foreignKeys: input.foreignKeys } : {}),
    ...(input.indexes !== undefined ? { indexes: input.indexes } : {}),
    ...(input.defaultSort !== undefined ? { defaultSort: input.defaultSort } : {}),
    ...(input.list !== undefined ? { list: input.list } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.children !== undefined ? { children: input.children } : {})
  };
}

/** Creates a TEXT column definition. */
export function textColumn(key: string, input: Omit<DataModelColumn, "key" | "type"> = {}): DataModelColumn {
  return { key, type: "text", ...input };
}

/** Creates an INTEGER column definition. */
export function integerColumn(key: string, input: Omit<DataModelColumn, "key" | "type"> = {}): DataModelColumn {
  return { key, type: "integer", ...input };
}

/** Creates a REAL column definition. */
export function realColumn(key: string, input: Omit<DataModelColumn, "key" | "type"> = {}): DataModelColumn {
  return { key, type: "real", ...input };
}

/**
 * Creates a boolean column definition.
 *
 * SQLite stores this as INTEGER. Add an explicit `checkSql`, such as
 * `"flag IN (0, 1)"`, when the table should enforce boolean storage.
 */
export function booleanColumn(key: string, input: Omit<DataModelColumn, "key" | "type"> = {}): DataModelColumn {
  return { key, type: "boolean", ...input };
}

/**
 * Creates a JSON column definition.
 *
 * JSON columns are stored as TEXT and parsed by {@link listDataModelRows}. They
 * are not filterable through generated equality filters.
 */
export function jsonColumn(key: string, input: Omit<DataModelColumn, "key" | "type"> = {}): DataModelColumn {
  return { key, type: "json", ...input };
}

/**
 * Creates all tables and indexes for a domain if they do not already exist.
 *
 * This is intended for fresh database/table-group initialization. Existing
 * tables are left in place by SQLite `CREATE TABLE IF NOT EXISTS`.
 */
export function createDataDomainSchema(db: SqliteDatabase, domain: DataDomainModel): void {
  for (const table of Object.values(domain.tables)) {
    db.exec(createTableSql(table));
  }
  for (const table of Object.values(domain.tables)) {
    for (const index of table.indexes ?? []) {
      db.exec(createIndexSql(table, index));
    }
  }
}

/**
 * Applies additive schema migration for a domain.
 *
 * Supported changes:
 * - create missing tables
 * - add missing non-primary-key physical columns
 * - create missing indexes
 *
 * Unsupported changes throw when they cannot be made safely, for example adding
 * a primary key column or adding a `NOT NULL` column without `defaultSql`.
 *
 * @returns `true` when the database was changed.
 */
export function migrateDataDomainSchema(db: SqliteDatabase, domain: DataDomainModel): boolean {
  let changed = false;
  for (const table of Object.values(domain.tables)) {
    if (!sqliteObjectExists(db, "table", table.table)) {
      db.exec(createTableSql(table));
      changed = true;
      continue;
    }
    const actualColumns = new Set(readTableColumnNames(db, table.table));
    for (const column of physicalColumns(table)) {
      const name = columnName(column);
      if (actualColumns.has(name)) {
        continue;
      }
      if (table.primaryKey.includes(column.key)) {
        throw new Error(`Cannot add missing primary key column through data model migration: ${table.table}.${column.key}`);
      }
      if (column.notNull && !column.defaultSql) {
        throw new Error(`Cannot add NOT NULL column without default through data model migration: ${table.table}.${column.key}`);
      }
      db.exec(`ALTER TABLE ${quoteIdent(table.table)} ADD COLUMN ${columnDefinitionSql(column, false)};`);
      changed = true;
    }
  }
  for (const table of Object.values(domain.tables)) {
    for (const index of table.indexes ?? []) {
      if (!sqliteObjectExists(db, "index", index.name)) {
        db.exec(createIndexSql(table, index));
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Validates that the database contains the physical columns and indexes declared
 * by a data-model domain.
 *
 * This validates storage shape only. It does not compare every constraint or
 * SQL expression in the model.
 */
export function validateDataDomainSchema(db: SqliteDatabase, domain: DataDomainModel): void {
  for (const table of Object.values(domain.tables)) {
    assertTableColumns(db, table.table, Object.fromEntries(
      physicalColumns(table).map((column) => [columnName(column), sqliteType(column)])
    ));
    for (const index of table.indexes ?? []) {
      assertIndexExists(db, index.name);
    }
  }
}

/**
 * Converts a data-model domain into `SqliteService` table-group definitions.
 *
 * Use this when registering a model domain with the existing SQLite lifecycle:
 * creation, additive migration, validation, and reset policy handling.
 */
export function createTableGroupsFromDataDomain(domain: DataDomainModel): SqliteTableGroupDefinition[] {
  return [{
    groupId: domain.tableGroup,
    schemaVersion: domain.schemaVersion ?? 1,
    ...(domain.resetPolicy !== undefined ? { resetPolicy: domain.resetPolicy } : {}),
    ownedTables: Object.values(domain.tables).map((table) => table.table),
    ownedIndexes: Object.values(domain.tables).flatMap((table) => (table.indexes ?? []).map((index) => index.name)),
    createSchema: (db) => createDataDomainSchema(db, domain),
    migrateSchema: (db) => migrateDataDomainSchema(db, domain),
    validateSchema: (db) => validateDataDomainSchema(db, domain)
  }];
}

/**
 * Lists rows from a modeled table using generated SQL.
 *
 * Returned row keys use logical column keys, not physical SQLite column names.
 * JSON columns are parsed before returning. Hidden columns are omitted, and
 * computed columns are included only when they define `selectSql`.
 */
export function listDataModelRows<TRow extends Record<string, unknown>>(
  db: SqliteDatabase,
  table: DataTableModel,
  input: DataModelListRowsInput = {}
): { rows: TRow[]; total: number; offset: number; limit: number } {
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
  const filters = buildWhereClause(table, input.filters);
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table.table)}${filters.whereSql}`).get(...filters.params) as { count: number }).count;
  const rows = db.prepare(`
    SELECT
      ${selectableColumns(table).map((column) => `${column.selectSql ?? `${quoteIdent(columnName(column))}`} AS ${quoteIdent(column.key)}`).join(",\n      ")}
    FROM ${quoteIdent(table.table)}
    ${filters.whereSql}
    ${orderBySql(table)}
    LIMIT ? OFFSET ?
  `).all(...filters.params, limit, offset) as TRow[];
  return {
    rows: rows.map((row) => parseJsonColumns(table, row)),
    total,
    offset,
    limit
  };
}

function createTableSql(table: DataTableModel): string {
  const columnSql = physicalColumns(table).map((column) => columnDefinitionSql(column, table.primaryKey.includes(column.key)));
  const constraints = [
    `PRIMARY KEY (${table.primaryKey.map((key) => quoteIdent(storageNameForKey(table, key))).join(", ")})`,
    ...(table.unique ?? []).map((columns) => `UNIQUE (${columns.map((key) => quoteIdent(storageNameForKey(table, key))).join(", ")})`),
    ...(table.foreignKeys ?? []).map((foreignKey) => [
      `FOREIGN KEY (${foreignKey.columns.map((key) => quoteIdent(storageNameForKey(table, key))).join(", ")})`,
      `REFERENCES ${quoteIdent(foreignKey.referencesTable)}(${foreignKey.referencesColumns.map(quoteIdent).join(", ")})`,
      foreignKey.onDelete ? `ON DELETE ${foreignKey.onDelete}` : null
    ].filter(Boolean).join(" "))
  ];
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.table)} (\n  ${[...columnSql, ...constraints].join(",\n  ")}\n);`;
}

function columnDefinitionSql(column: DataModelColumn, primaryKeyColumn: boolean): string {
  return [
    quoteIdent(columnName(column)),
    sqliteType(column),
    column.notNull || primaryKeyColumn ? "NOT NULL" : null,
    column.defaultSql ? `DEFAULT ${column.defaultSql}` : null,
    column.checkSql ? `CHECK (${column.checkSql})` : null
  ].filter(Boolean).join(" ");
}

function selectableColumns(table: DataTableModel): DataModelColumn[] {
  return table.columns.filter((column) => !column.hidden && (column.storage !== "computed" || column.selectSql));
}

function buildWhereClause(table: DataTableModel, filters: Record<string, unknown> | undefined): { whereSql: string; params: unknown[] } {
  if (!filters) {
    return { whereSql: "", params: [] };
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === "") {
      continue;
    }
    const column = table.columns.find((item) => item.key === key);
    if (!column || column.storage === "computed" || column.type === "json") {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    clauses.push(`${quoteIdent(columnName(column))} = ?`);
    params.push(column.type === "boolean" ? (value ? 1 : 0) : value);
  }
  return {
    whereSql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function orderBySql(table: DataTableModel): string {
  const sort = table.defaultSort ?? [];
  const clauses = sort
    .map((entry) => {
      const column = table.columns.find((item) => item.key === entry.column);
      if (!column || column.storage === "computed") {
        return null;
      }
      return `${quoteIdent(columnName(column))} ${entry.direction.toUpperCase()}`;
    })
    .filter((entry): entry is string => Boolean(entry));
  const primaryKeyColumns = table.primaryKey
    .map((key) => table.columns.find((column) => column.key === key))
    .filter(isPhysicalColumn)
    .map((column) => `${quoteIdent(columnName(column))} ASC`);
  return `ORDER BY ${[...clauses, ...primaryKeyColumns].join(", ")}`;
}

function parseJsonColumns<TRow extends Record<string, unknown>>(table: DataTableModel, row: TRow): TRow {
  const next: Record<string, unknown> = { ...row };
  for (const column of selectableColumns(table)) {
    if (column.type !== "json" || typeof next[column.key] !== "string") {
      continue;
    }
    next[column.key] = JSON.parse(next[column.key] as string);
  }
  return next as TRow;
}

function isPhysicalColumn(column: DataModelColumn | undefined): column is DataModelColumn {
  return column !== undefined && column.storage !== "computed";
}

function createIndexSql(table: DataTableModel, index: DataModelIndex): string {
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(table.table)}(${index.columns.map((key) => quoteIdent(storageNameForKey(table, key))).join(", ")});`;
}

function physicalColumns(table: DataTableModel): DataModelColumn[] {
  return table.columns.filter((column) => column.storage !== "computed");
}

function storageNameForKey(table: DataTableModel, key: string): string {
  const column = table.columns.find((item) => item.key === key);
  if (!column) {
    throw new Error(`Unknown data model column: ${table.table}.${key}`);
  }
  if (column.storage === "computed") {
    throw new Error(`Computed data model column cannot be used in SQL: ${table.table}.${key}`);
  }
  return columnName(column);
}

function columnName(column: DataModelColumn): string {
  return column.storageName ?? column.key;
}

function sqliteType(column: DataModelColumn): string {
  if (column.type === "integer" || column.type === "boolean") return "INTEGER";
  if (column.type === "real") return "REAL";
  return "TEXT";
}

function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function readTableColumnNames(db: SqliteDatabase, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function sqliteObjectExists(db: SqliteDatabase, type: "table" | "index", name: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = ?
      AND name = ?
  `).get(type, name) as { name: string } | undefined;
  return Boolean(row);
}

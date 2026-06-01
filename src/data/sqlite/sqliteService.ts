import { mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { Logger } from "pino";

export type SqliteDatabase = BetterSqlite3.Database;

export type SqliteTableGroupResetPolicy = "reset_allowed" | "block_reset";

export interface SqliteTableGroupDefinition {
  groupId: string;
  schemaVersion: number;
  minReadableSchemaVersion?: number;
  ownedTables: string[];
  ownedIndexes?: string[];
  dependsOn?: string[];
  resetPolicy?: SqliteTableGroupResetPolicy;
  createSchema: (db: SqliteDatabase) => void;
  adoptExistingSchema?: (db: SqliteDatabase) => void;
  migrateSchema?: (db: SqliteDatabase) => boolean;
  validateSchema: (db: SqliteDatabase) => void;
}

export interface SqliteDatabaseDefinition {
  databaseId: string;
  dbPath: string;
  tableGroups: SqliteTableGroupDefinition[];
  pragmas?: {
    wal?: boolean;
    foreignKeys?: boolean;
    busyTimeoutMs?: number;
  };
  selfHealing?: {
    resetDatabaseOnOpenFailure?: boolean;
    resetDatabaseOnIntegrityFailure?: boolean;
    backupInvalidDatabase?: boolean;
  };
}

export interface SqliteTableGroupStatus {
  groupId: string;
  schemaVersion: number;
  minReadableSchemaVersion: number;
  resetPolicy: SqliteTableGroupResetPolicy;
  actualSchemaVersion?: number;
  lastResetAt?: number;
  lastResetReason?: string;
}

export interface SqliteDatabaseStatus {
  databaseId: string;
  available: boolean;
  dbPath: string;
  disabledReason?: string;
  lastDatabaseResetReason?: string;
  tableGroups: SqliteTableGroupStatus[];
}

export interface SqliteDatabaseHandle {
  readonly databaseId: string;
  readonly dbPath: string;
  readonly db: SqliteDatabase;
  getStatus: () => SqliteDatabaseStatus;
  read: <T>(fn: (db: SqliteDatabase) => T) => T;
  write: <T>(fn: (db: SqliteDatabase) => T) => T;
  transaction: <T>(fn: (db: SqliteDatabase) => T) => T;
  close: () => void;
}

interface SchemaGroupRow {
  group_id: string;
  schema_version: number;
  owned_tables_json: string;
  owned_indexes_json: string;
  created_at: number;
  updated_at: number;
  last_reset_at: number | null;
  last_reset_reason: string | null;
}

export class SqliteService {
  constructor(private readonly logger: Logger) { }

  async openDatabase(definition: SqliteDatabaseDefinition): Promise<SqliteDatabaseHandle> {
    await mkdir(dirname(definition.dbPath), { recursive: true });
    const db = await this.openWithDatabaseHealing(definition);
    try {
      applyPragmas(db, definition);
      assertDatabaseIntegrity(db);
      ensureSchemaGroupMeta(db);
      initializeTableGroups(db, definition, this.logger);
      return createHandle(definition, db);
    } catch (error) {
      db.close();
      if (!definition.selfHealing?.resetDatabaseOnIntegrityFailure || !isIntegrityFailure(error)) {
        throw error;
      }
      await isolateDatabaseFiles(definition, "integrity_failure", this.logger);
      const healedDb = await openBetterSqliteDatabase(definition.dbPath);
      applyPragmas(healedDb, definition);
      ensureSchemaGroupMeta(healedDb);
      initializeTableGroups(healedDb, definition, this.logger);
      return createHandle(definition, healedDb, "integrity_failure");
    }
  }

  private async openWithDatabaseHealing(definition: SqliteDatabaseDefinition): Promise<SqliteDatabase> {
    try {
      return await openBetterSqliteDatabase(definition.dbPath);
    } catch (error) {
      if (!definition.selfHealing?.resetDatabaseOnOpenFailure) {
        throw error;
      }
      await isolateDatabaseFiles(definition, "open_failure", this.logger);
      return openBetterSqliteDatabase(definition.dbPath);
    }
  }
}

export function assertTableExists(db: SqliteDatabase, tableName: string): void {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
  `).get(tableName) as { name: string } | undefined;
  if (!row) {
    throw new Error(`SQLite table ${tableName} is missing`);
  }
}

export function assertIndexExists(db: SqliteDatabase, indexName: string): void {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index'
      AND name = ?
  `).get(indexName) as { name: string } | undefined;
  if (!row) {
    throw new Error(`SQLite index ${indexName} is missing`);
  }
}

export function assertTableColumns(
  db: SqliteDatabase,
  tableName: string,
  expectedColumns: Record<string, string>
): void {
  assertTableExists(db, tableName);
  const columns = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{
    name: string;
    type: string;
  }>;
  const actual = new Map(columns.map((column) => [column.name, column.type.toLocaleUpperCase()]));
  for (const [columnName, expectedType] of Object.entries(expectedColumns)) {
    const actualType = actual.get(columnName);
    if (!actualType) {
      throw new Error(`SQLite column ${tableName}.${columnName} is missing`);
    }
    if (actualType !== expectedType.toLocaleUpperCase()) {
      throw new Error(`SQLite column ${tableName}.${columnName} type mismatch: expected ${expectedType}, got ${actualType}`);
    }
  }
}

export function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function openBetterSqliteDatabase(dbPath: string): Promise<SqliteDatabase> {
  const { default: Database } = await import("better-sqlite3");
  return new Database(dbPath);
}

function createHandle(
  definition: SqliteDatabaseDefinition,
  db: SqliteDatabase,
  lastDatabaseResetReason?: string
): SqliteDatabaseHandle {
  let closed = false;
  return {
    databaseId: definition.databaseId,
    dbPath: definition.dbPath,
    db,
    getStatus: () => ({
      databaseId: definition.databaseId,
      available: !closed,
      dbPath: definition.dbPath,
      ...(lastDatabaseResetReason ? { lastDatabaseResetReason } : {}),
      tableGroups: listTableGroupStatuses(db, definition.tableGroups)
    }),
    read: <T>(fn: (database: SqliteDatabase) => T) => fn(db),
    write: <T>(fn: (database: SqliteDatabase) => T) => fn(db),
    transaction: <T>(fn: (database: SqliteDatabase) => T) => {
      const transaction = db.transaction(() => fn(db));
      return transaction() as T;
    },
    close: () => {
      if (closed) {
        return;
      }
      db.close();
      closed = true;
    }
  };
}

function applyPragmas(db: SqliteDatabase, definition: SqliteDatabaseDefinition): void {
  const pragmas = definition.pragmas ?? {};
  db.pragma(`busy_timeout = ${Math.max(0, pragmas.busyTimeoutMs ?? 5000)}`);
  if (pragmas.wal !== false) {
    db.pragma("journal_mode = WAL");
  }
  if (pragmas.foreignKeys !== false) {
    db.pragma("foreign_keys = ON");
  }
}

function assertDatabaseIntegrity(db: SqliteDatabase): void {
  const result = String(db.pragma("integrity_check", { simple: true }) ?? "");
  if (result !== "ok") {
    throw new Error(`SQLite integrity check failed: ${result}`);
  }
}

function ensureSchemaGroupMeta(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS __sqlite_schema_groups (
      group_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      owned_tables_json TEXT NOT NULL,
      owned_indexes_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_reset_at INTEGER,
      last_reset_reason TEXT
    );
  `);
}

function initializeTableGroups(
  db: SqliteDatabase,
  definition: SqliteDatabaseDefinition,
  logger: Logger
): void {
  const groups = sortTableGroups(definition.tableGroups);
  const groupMap = new Map(groups.map((group) => [group.groupId, group]));
  const resetGroups = new Set<string>();
  for (const group of groups) {
    if (resetGroups.has(group.groupId)) {
      continue;
    }
    const resetReason = getTableGroupResetReason(db, group, resetGroups);
    if (!resetReason) {
      continue;
    }
    const affectedGroups = collectGroupWithDependents(group.groupId, groups, groupMap)
      .filter((candidate) => !resetGroups.has(candidate.groupId));
    const resetReasons = new Map(affectedGroups.map((affectedGroup) => [
      affectedGroup.groupId,
      affectedGroup.groupId === group.groupId ? resetReason : `dependency_reset:${group.groupId}`
    ]));
    assertTableGroupResetAllowed(db, affectedGroups, resetReasons);
    resetTableGroups(db, definition, affectedGroups, resetReasons, logger);
    for (const affectedGroup of affectedGroups) {
      resetGroups.add(affectedGroup.groupId);
    }
  }
}

function getTableGroupResetReason(
  db: SqliteDatabase,
  group: SqliteTableGroupDefinition,
  resetGroups: Set<string>
): string | null {
  for (const dependency of group.dependsOn ?? []) {
    if (resetGroups.has(dependency)) {
      return `dependency_reset:${dependency}`;
    }
  }
  const meta = readTableGroupMeta(db, group.groupId);
  if (meta && meta.schema_version !== group.schemaVersion) {
    if (isTableGroupSchemaReadable(group, meta) && tryMigrateTableGroup(db, group, meta)) {
      return null;
    }
    return "schema_version_mismatch";
  }
  if (!meta) {
    group.adoptExistingSchema?.(db);
  }
  try {
    group.validateSchema(db);
  } catch (error) {
    if (meta && isTableGroupSchemaReadable(group, meta) && tryMigrateTableGroup(db, group, meta)) {
      return null;
    }
    if (meta) {
      return "schema_validation_failed";
    }
    return "schema_missing";
  }
  if (!meta) {
    writeTableGroupMeta(db, group);
  }
  return null;
}

function tryMigrateTableGroup(
  db: SqliteDatabase,
  group: SqliteTableGroupDefinition,
  meta: SchemaGroupRow
): boolean {
  if (!group.migrateSchema) {
    return false;
  }
  try {
    const migrate = db.transaction(() => {
      const changed = group.migrateSchema?.(db) ?? false;
      if (!changed) {
        return false;
      }
      group.validateSchema(db);
      writeTableGroupMeta(db, group, {
        ...(meta.last_reset_at !== null ? { lastResetAt: meta.last_reset_at } : {}),
        ...(meta.last_reset_reason !== null ? { lastResetReason: meta.last_reset_reason } : {})
      });
      return true;
    });
    return migrate() as boolean;
  } catch {
    return false;
  }
}

function assertTableGroupResetAllowed(
  db: SqliteDatabase,
  groups: SqliteTableGroupDefinition[],
  resetReasons: Map<string, string>
): void {
  const blockedGroups = groups.filter((group) =>
    getResetPolicy(group) === "block_reset" && !isFreshTableGroup(db, group)
  );
  if (blockedGroups.length === 0) {
    return;
  }

  const details = blockedGroups
    .map((group) => `${group.groupId}(${resetReasons.get(group.groupId) ?? "unknown"})`)
    .join(", ");
  throw new Error(`SQLite table group reset blocked by resetPolicy=block_reset: ${details}`);
}

function getResetPolicy(group: SqliteTableGroupDefinition): SqliteTableGroupResetPolicy {
  return group.resetPolicy ?? "reset_allowed";
}

function isTableGroupSchemaReadable(group: SqliteTableGroupDefinition, meta: SchemaGroupRow): boolean {
  return meta.schema_version >= getMinReadableSchemaVersion(group);
}

function getMinReadableSchemaVersion(group: SqliteTableGroupDefinition): number {
  return group.minReadableSchemaVersion ?? group.schemaVersion;
}

function isFreshTableGroup(db: SqliteDatabase, group: SqliteTableGroupDefinition): boolean {
  if (readTableGroupMeta(db, group.groupId)) {
    return false;
  }
  return [
    ...group.ownedTables.map((name) => ({ type: "table", name })),
    ...(group.ownedIndexes ?? []).map((name) => ({ type: "index", name }))
  ].every((item) => !sqliteObjectExists(db, item.type, item.name));
}

function sqliteObjectExists(db: SqliteDatabase, type: string, name: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = ?
      AND name = ?
  `).get(type, name) as { name: string } | undefined;
  return Boolean(row);
}

function resetTableGroups(
  db: SqliteDatabase,
  definition: SqliteDatabaseDefinition,
  groups: SqliteTableGroupDefinition[],
  resetReasons: Map<string, string>,
  logger: Logger
): void {
  const now = Date.now();
  const reverseGroups = [...groups].reverse();
  db.pragma("foreign_keys = OFF");
  try {
    const reset = db.transaction(() => {
      for (const group of reverseGroups) {
        for (const indexName of group.ownedIndexes ?? []) {
          db.exec(`DROP INDEX IF EXISTS ${quoteIdent(indexName)}`);
        }
      }
      for (const group of reverseGroups) {
        for (const tableName of [...group.ownedTables].reverse()) {
          db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
        }
      }
      for (const group of groups) {
        group.createSchema(db);
      }
      for (const group of groups) {
        group.validateSchema(db);
        writeTableGroupMeta(db, group, {
          now,
          lastResetAt: now,
          lastResetReason: resetReasons.get(group.groupId) ?? "unknown"
        });
      }
    });
    reset();
    logger.warn({
      groupIds: groups.map((group) => group.groupId),
      reasons: Object.fromEntries(resetReasons)
    }, "sqlite_table_groups_reset");
  } finally {
    db.pragma(definition.pragmas?.foreignKeys === false ? "foreign_keys = OFF" : "foreign_keys = ON");
  }
}

function readTableGroupMeta(db: SqliteDatabase, groupId: string): SchemaGroupRow | null {
  return db.prepare(`
    SELECT *
    FROM __sqlite_schema_groups
    WHERE group_id = ?
  `).get(groupId) as SchemaGroupRow | undefined ?? null;
}

function writeTableGroupMeta(
  db: SqliteDatabase,
  group: SqliteTableGroupDefinition,
  input: {
    now?: number;
    lastResetAt?: number;
    lastResetReason?: string;
  } = {}
): void {
  const now = input.now ?? Date.now();
  db.prepare(`
    INSERT INTO __sqlite_schema_groups (
      group_id, schema_version, owned_tables_json, owned_indexes_json,
      created_at, updated_at, last_reset_at, last_reset_reason
    )
    VALUES (
      @groupId, @schemaVersion, @ownedTablesJson, @ownedIndexesJson,
      @createdAt, @updatedAt, @lastResetAt, @lastResetReason
    )
    ON CONFLICT(group_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      owned_tables_json = excluded.owned_tables_json,
      owned_indexes_json = excluded.owned_indexes_json,
      updated_at = excluded.updated_at,
      last_reset_at = excluded.last_reset_at,
      last_reset_reason = excluded.last_reset_reason
  `).run({
    groupId: group.groupId,
    schemaVersion: group.schemaVersion,
    ownedTablesJson: JSON.stringify(group.ownedTables),
    ownedIndexesJson: JSON.stringify(group.ownedIndexes ?? []),
    createdAt: now,
    updatedAt: now,
    lastResetAt: input.lastResetAt ?? null,
    lastResetReason: input.lastResetReason ?? null
  });
}

function listTableGroupStatuses(
  db: SqliteDatabase,
  groups: SqliteTableGroupDefinition[]
): SqliteTableGroupStatus[] {
  return groups.map((group) => {
    const meta = readTableGroupMeta(db, group.groupId);
    return {
      groupId: group.groupId,
      schemaVersion: group.schemaVersion,
      minReadableSchemaVersion: getMinReadableSchemaVersion(group),
      resetPolicy: getResetPolicy(group),
      ...(meta ? { actualSchemaVersion: meta.schema_version } : {}),
      ...(meta?.last_reset_at !== null && meta?.last_reset_at !== undefined ? { lastResetAt: meta.last_reset_at } : {}),
      ...(meta?.last_reset_reason ? { lastResetReason: meta.last_reset_reason } : {})
    };
  });
}

function sortTableGroups(groups: SqliteTableGroupDefinition[]): SqliteTableGroupDefinition[] {
  const groupMap = new Map(groups.map((group) => [group.groupId, group]));
  const sorted: SqliteTableGroupDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (group: SqliteTableGroupDefinition): void => {
    if (visited.has(group.groupId)) {
      return;
    }
    if (visiting.has(group.groupId)) {
      throw new Error(`SQLite table group dependency cycle at ${group.groupId}`);
    }
    visiting.add(group.groupId);
    for (const dependencyId of group.dependsOn ?? []) {
      const dependency = groupMap.get(dependencyId);
      if (!dependency) {
        throw new Error(`SQLite table group ${group.groupId} depends on unknown group ${dependencyId}`);
      }
      visit(dependency);
    }
    visiting.delete(group.groupId);
    visited.add(group.groupId);
    sorted.push(group);
  };
  for (const group of groups) {
    visit(group);
  }
  return sorted;
}

function collectGroupWithDependents(
  groupId: string,
  groups: SqliteTableGroupDefinition[],
  groupMap: Map<string, SqliteTableGroupDefinition>
): SqliteTableGroupDefinition[] {
  const selected = new Set<string>([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (selected.has(group.groupId)) {
        continue;
      }
      if ((group.dependsOn ?? []).some((dependency) => selected.has(dependency))) {
        selected.add(group.groupId);
        changed = true;
      }
    }
  }
  return groups.filter((group) => selected.has(group.groupId) && groupMap.has(group.groupId));
}

function isIntegrityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /integrity check failed|database disk image is malformed|file is not a database|database is corrupt/iu.test(message);
}

async function isolateDatabaseFiles(
  definition: SqliteDatabaseDefinition,
  reason: string,
  logger: Logger
): Promise<void> {
  if (definition.selfHealing?.backupInvalidDatabase === false) {
    await removeKnownDatabaseFiles(definition.dbPath);
    return;
  }
  const backupDir = join(dirname(definition.dbPath), "invalid");
  await mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const files = [
    definition.dbPath,
    `${definition.dbPath}-wal`,
    `${definition.dbPath}-shm`
  ];
  for (const filePath of files) {
    if (!await fileExists(filePath)) {
      continue;
    }
    const target = join(backupDir, `${basename(filePath)}.${reason}.${timestamp}`);
    await rename(filePath, target);
    logger.warn({
      databaseId: definition.databaseId,
      sourcePath: filePath,
      backupPath: target,
      reason
    }, "sqlite_database_file_isolated");
  }
}

async function removeKnownDatabaseFiles(dbPath: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true })
  ]);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

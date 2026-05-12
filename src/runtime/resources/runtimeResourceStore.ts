import type { StateDatabase } from "#data/state/stateDatabase.ts";
import type {
  BrowserPageRecoveryState,
  RuntimeResourceKind,
  RuntimeResourceRecord,
  RuntimeResourceStatus,
  ShellSessionRecoveryState
} from "./resourceTypes.ts";

export class RuntimeResourceStore {
  constructor(private readonly stateDb: StateDatabase) {}

  async init(): Promise<void> {
    await this.stateDb.init();
  }

  private async getReadyDb() {
    await this.stateDb.init();
    return this.stateDb.getDb();
  }

  async list(kind?: RuntimeResourceKind): Promise<RuntimeResourceRecord[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT r.resource_id, r.kind, r.status, r.owner_session_id, r.title, r.description,
             r.summary, r.created_at_ms, r.last_accessed_at_ms, r.expires_at_ms,
             bp.requested_url, bp.resolved_url, bp.backend, bp.title AS bp_title, bp.profile_id,
             ss.command, ss.cwd, ss.shell, ss.tty, ss.login
      FROM runtime_resources r
      LEFT JOIN runtime_browser_pages bp ON r.resource_id = bp.resource_id
      LEFT JOIN runtime_shell_sessions ss ON r.resource_id = ss.resource_id
      ${kind ? "WHERE r.kind = ?" : ""}
      ORDER BY r.last_accessed_at_ms DESC
    `).all(...(kind ? [kind] : [])) as RuntimeResourceRow[];
    return rows.map(rowToRecord);
  }

  async listActive(kind?: RuntimeResourceKind): Promise<RuntimeResourceRecord[]> {
    const all = await this.list(kind);
    return all.filter((r) => r.status === "active");
  }

  async upsert(record: RuntimeResourceRecord): Promise<void> {
    const db = await this.getReadyDb();
    const upsertBase = db.prepare(`
      INSERT INTO runtime_resources (
        resource_id, kind, status, owner_session_id, title, description,
        summary, created_at_ms, last_accessed_at_ms, expires_at_ms
      ) VALUES (
        @resourceId, @kind, @status, @ownerSessionId, @title, @description,
        @summary, @createdAtMs, @lastAccessedAtMs, @expiresAtMs
      )
      ON CONFLICT(resource_id) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        owner_session_id = excluded.owner_session_id,
        title = excluded.title,
        description = excluded.description,
        summary = excluded.summary,
        last_accessed_at_ms = excluded.last_accessed_at_ms,
        expires_at_ms = excluded.expires_at_ms
    `);

    const deleteBrowser = db.prepare("DELETE FROM runtime_browser_pages WHERE resource_id = ?");
    const deleteShell = db.prepare("DELETE FROM runtime_shell_sessions WHERE resource_id = ?");

    const insertBrowser = db.prepare(`
      INSERT INTO runtime_browser_pages (resource_id, requested_url, resolved_url, backend, title, profile_id)
      VALUES (@resourceId, @requestedUrl, @resolvedUrl, @backend, @title, @profileId)
    `);

    const insertShell = db.prepare(`
      INSERT INTO runtime_shell_sessions (resource_id, command, cwd, shell, tty, login)
      VALUES (@resourceId, @command, @cwd, @shell, @tty, @login)
    `);

    const upsert = db.transaction(() => {
      upsertBase.run({
        resourceId: record.resourceId,
        kind: record.kind,
        status: record.status,
        ownerSessionId: record.ownerSessionId,
        title: record.title,
        description: record.description,
        summary: record.summary,
        createdAtMs: record.createdAtMs,
        lastAccessedAtMs: record.lastAccessedAtMs,
        expiresAtMs: record.expiresAtMs
      });

      deleteBrowser.run(record.resourceId);
      deleteShell.run(record.resourceId);

      if (record.kind === "browser_page") {
        if (!record.browserPage) {
          throw new Error("browser_page record requires browserPage data");
        }
        insertBrowser.run({
          resourceId: record.resourceId,
          requestedUrl: record.browserPage.requestedUrl,
          resolvedUrl: record.browserPage.resolvedUrl,
          backend: record.browserPage.backend,
          title: record.browserPage.title,
          profileId: record.browserPage.profileId
        });
      } else if (record.kind === "shell_session") {
        if (!record.shellSession) {
          throw new Error("shell_session record requires shellSession data");
        }
        insertShell.run({
          resourceId: record.resourceId,
          command: record.shellSession.command,
          cwd: record.shellSession.cwd,
          shell: record.shellSession.shell,
          tty: record.shellSession.tty ? 1 : 0,
          login: record.shellSession.login ? 1 : 0
        });
      }
    });

    upsert();
  }

  async update(resourceId: string, patch: {
    status?: RuntimeResourceStatus;
    title?: string | null;
    description?: string | null;
    summary?: string;
    lastAccessedAtMs?: number;
    expiresAtMs?: number | null;
  }): Promise<RuntimeResourceRecord | null> {
    const db = await this.getReadyDb();
    const sets: string[] = [];
    const params: Record<string, unknown> = { resourceId };
    if (patch.status !== undefined) {
      sets.push("status = @status");
      params.status = patch.status;
    }
    if (patch.title !== undefined) {
      sets.push("title = @title");
      params.title = patch.title;
    }
    if (patch.description !== undefined) {
      sets.push("description = @description");
      params.description = patch.description;
    }
    if (patch.summary !== undefined) {
      sets.push("summary = @summary");
      params.summary = patch.summary;
    }
    if (patch.lastAccessedAtMs !== undefined) {
      sets.push("last_accessed_at_ms = @lastAccessedAtMs");
      params.lastAccessedAtMs = patch.lastAccessedAtMs;
    }
    if (patch.expiresAtMs !== undefined) {
      sets.push("expires_at_ms = @expiresAtMs");
      params.expiresAtMs = patch.expiresAtMs;
    }
    if (sets.length > 0) {
      db.prepare(`
        UPDATE runtime_resources SET ${sets.join(", ")} WHERE resource_id = @resourceId
      `).run(params);
    }
    return this.getRow(resourceId);
  }

  async getRow(resourceId: string): Promise<RuntimeResourceRecord | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT r.resource_id, r.kind, r.status, r.owner_session_id, r.title, r.description,
             r.summary, r.created_at_ms, r.last_accessed_at_ms, r.expires_at_ms,
             bp.requested_url, bp.resolved_url, bp.backend, bp.title AS bp_title, bp.profile_id,
             ss.command, ss.cwd, ss.shell, ss.tty, ss.login
      FROM runtime_resources r
      LEFT JOIN runtime_browser_pages bp ON r.resource_id = bp.resource_id
      LEFT JOIN runtime_shell_sessions ss ON r.resource_id = ss.resource_id
      WHERE r.resource_id = ?
    `).get(resourceId) as RuntimeResourceRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async reset(): Promise<void> {
    const db = await this.getReadyDb();
    db.prepare("DELETE FROM runtime_browser_pages").run();
    db.prepare("DELETE FROM runtime_shell_sessions").run();
    db.prepare("DELETE FROM runtime_resources").run();
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{ rows: unknown[]; total: number; offset: number; limit: number }> {
    const all = await this.list();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    return {
      rows: all.slice(offset, offset + limit),
      total: all.length,
      offset,
      limit
    };
  }

  async listBrowserPageRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: Array<{ resourceId: string; requestedUrl: string; resolvedUrl: string; backend: string; title: string | null; profileId: string | null }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const resourceId = typeof input.filters?.resourceId === "string" && input.filters.resourceId.trim()
      ? input.filters.resourceId.trim()
      : null;
    const whereSql = resourceId ? "WHERE resource_id = ?" : "";
    const params = resourceId ? [resourceId] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM runtime_browser_pages ${whereSql}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        resource_id AS resourceId,
        requested_url AS requestedUrl,
        resolved_url AS resolvedUrl,
        backend,
        title,
        profile_id AS profileId
      FROM runtime_browser_pages
      ${whereSql}
      ORDER BY resource_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{ resourceId: string; requestedUrl: string; resolvedUrl: string; backend: string; title: string | null; profileId: string | null }>;
    return { rows, total, offset, limit };
  }

  async listShellSessionRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: Array<{ resourceId: string; command: string; cwd: string; shell: string; tty: boolean; login: boolean }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const resourceId = typeof input.filters?.resourceId === "string" && input.filters.resourceId.trim()
      ? input.filters.resourceId.trim()
      : null;
    const whereSql = resourceId ? "WHERE resource_id = ?" : "";
    const params = resourceId ? [resourceId] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM runtime_shell_sessions ${whereSql}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        resource_id AS resourceId,
        command,
        cwd,
        shell,
        tty,
        login
      FROM runtime_shell_sessions
      ${whereSql}
      ORDER BY resource_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{ resourceId: string; command: string; cwd: string; shell: string; tty: 0 | 1; login: 0 | 1 }>;
    return {
      rows: rows.map((row) => ({ ...row, tty: row.tty === 1, login: row.login === 1 })),
      total,
      offset,
      limit
    };
  }
}

interface RuntimeResourceRow {
  resource_id: string;
  kind: string;
  status: string;
  owner_session_id: string | null;
  title: string | null;
  description: string | null;
  summary: string;
  created_at_ms: number;
  last_accessed_at_ms: number;
  expires_at_ms: number | null;
  requested_url: string | null;
  resolved_url: string | null;
  backend: string | null;
  bp_title: string | null;
  profile_id: string | null;
  command: string | null;
  cwd: string | null;
  shell: string | null;
  tty: number | null;
  login: number | null;
}

function rowToRecord(row: RuntimeResourceRow): RuntimeResourceRecord {
  const record: RuntimeResourceRecord = {
    resourceId: row.resource_id,
    kind: row.kind as RuntimeResourceKind,
    status: row.status as RuntimeResourceStatus,
    ownerSessionId: row.owner_session_id,
    title: row.title,
    description: row.description,
    summary: row.summary,
    createdAtMs: row.created_at_ms,
    lastAccessedAtMs: row.last_accessed_at_ms,
    expiresAtMs: row.expires_at_ms
  };
  if (row.kind === "browser_page" && row.requested_url) {
    record.browserPage = {
      requestedUrl: row.requested_url,
      resolvedUrl: row.resolved_url ?? row.requested_url,
      backend: (row.backend as "playwright") ?? "playwright",
      title: row.bp_title ?? null,
      profileId: row.profile_id ?? null
    };
  }
  if (row.kind === "shell_session" && row.command) {
    record.shellSession = {
      command: row.command,
      cwd: row.cwd ?? "",
      shell: row.shell ?? "",
      tty: row.tty === 1,
      login: row.login === 1
    };
  }
  return record;
}

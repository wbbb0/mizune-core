import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import {
  bulkDeleteContextItems,
  clearContextEmbeddings,
  compactContextUser,
  createWebSession,
  deleteContextItem,
  deleteSession,
  getConfigSummary,
  getContextStatus,
  getHealthStatus,
  exportContextItems,
  importContextItems,
  getPersona,
  getSessionListStream,
  getSessionDetail,
  listAvailableSessionModes,
  listContextItems,
  listSessions,
  listUsers,
  getWhitelist,
  regenerateSessionTitle,
  resetContextIndex,
  rebuildContextIndex,
  setContextItemPinned,
  sweepDeletedContextItems,
  switchSessionMode,
  updateContextItem,
  updateSessionModeState,
  updateSessionTitle
} from "../application/basicAdminService.ts";
import { listRequests, listScheduledJobs } from "../application/operationsAdminService.ts";
import { replyWithSseStream } from "./sse.ts";
import {
  parseCreateSessionBody,
  parseConfigSaveBody,
  parseConfigValidateBody,
  parseEditorOptionsParams,
  parseEditorResourceParams,
  parseResourceItemParams,
  parseWorkspaceStoredFileParams,
  parseWorkspaceFileQuery,
  parseWorkspacePathQuery,
  parseOrReply,
  parseSwitchSessionModeBody,
  parseUpdateSessionTitleBody,
  parseUpdateSessionModeStateBody,
  parseSessionParams,
  respondBadRequest,
  respondNotFound
} from "../routeSupport.ts";
import type { InternalApiServices } from "../types.ts";

export function registerBasicRoutes(app: FastifyInstance, services: InternalApiServices["basicRoutes"]): void {
  app.get("/healthz", async () => getHealthStatus());

  app.get("/api/config-summary", async () => getConfigSummary(services.config));

  app.get("/api/editors", async () => services.editor.listResources());

  app.get("/api/data/resources", async () => services.dataBrowser.listResources());

  app.get("/api/data/resources/:resource", async (request, reply) => {
    const params = parseEditorResourceParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    try {
      return await services.dataBrowser.getResource(params.resource);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/data/resources/:resource/items/:item", async (request, reply) => {
    const params = parseResourceItemParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    try {
      return await services.dataBrowser.getResourceItem(params.resource, params.item);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/local-files/items", async (request, reply) => {
    const query = parseWorkspacePathQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      return await services.localFileAdmin.listItems(query.path);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/local-files/stat", async (request, reply) => {
    const query = parseWorkspacePathQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      return await services.localFileAdmin.statItem(query.path);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/local-files/file", async (request, reply) => {
    const query = parseWorkspaceFileQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      return await services.localFileAdmin.readFile(query.path, {
        ...(query.startLine != null ? { startLine: query.startLine } : {}),
        ...(query.endLine != null ? { endLine: query.endLine } : {})
      });
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/local-files/content", async (request, reply) => {
    const query = parseWorkspacePathQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      const result = await services.localFileAdmin.readFileContent(query.path);
      applyImageCacheHeaders(reply, request.headers["if-none-match"], result.contentType, result.buffer);
      if (reply.statusCode === 304) {
        return reply.send();
      }
      reply.type(result.contentType);
      return reply.send(result.buffer);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/local-files/send-content", async (request, reply) => {
    const query = parseWorkspacePathQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      const result = await services.localFileAdmin.readSendableFileContent(query.path);
      applyImageCacheHeaders(reply, request.headers["if-none-match"], result.contentType, result.buffer);
      if (reply.statusCode === 304) {
        return reply.send();
      }
      reply.type(result.contentType);
      return reply.send(result.buffer);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/chat-files", async () => services.localFileAdmin.listFiles());

  app.get("/api/chat-files/:fileId", async (request, reply) => {
    const params = parseWorkspaceStoredFileParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    try {
      const result = await services.localFileAdmin.getFile(params.fileId);
      if (!result.file) {
        return respondNotFound(reply, "Chat file not found");
      }
      return result;
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/chat-files/:fileId/content", async (request, reply) => {
    const params = parseWorkspaceStoredFileParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    try {
      const result = await services.localFileAdmin.readFileContentById(params.fileId);
      if (!result.file || !result.buffer) {
        return respondNotFound(reply, "Chat file not found");
      }

      applyImageCacheHeaders(reply, request.headers["if-none-match"], result.file.mimeType || "application/octet-stream", result.buffer);
      if (reply.statusCode === 304) {
        return reply.send();
      }
      reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(result.file.sourceName || result.file.fileId)}"`);
      reply.type(result.file.mimeType || "application/octet-stream");
      return reply.send(result.buffer);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/editors/:resource", async (request, reply) => {
    const params = parseEditorResourceParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    try {
      return await services.editor.loadResourceModel(params.resource);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/editors/:resource/validate", async (request, reply) => {
    const params = parseEditorResourceParams(request.params);
    const body = parseConfigValidateBody(request.body);
    if (!parseOrReply(reply, params) || !parseOrReply(reply, body)) {
      return reply;
    }

    try {
      return await services.editor.validateDraft(params.resource, body.value);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/editors/:resource/save", async (request, reply) => {
    const params = parseEditorResourceParams(request.params);
    const body = parseConfigSaveBody(request.body);
    if (!parseOrReply(reply, params) || !parseOrReply(reply, body)) {
      return reply;
    }

    try {
      return await services.editor.saveDraft(params.resource, body.value);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/editor-options/:key", async (request, reply) => {
    const params = parseEditorOptionsParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    try {
      return await services.editor.getOptions(params.key);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/users", async () => listUsers(services.config));

  app.get("/api/context/status", async () => getContextStatus(services.config));

  app.get("/api/context/items", async (request, reply) => {
    try {
      return listContextItems(services.config, parseContextItemsQuery(request.query));
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/context/items/:itemId", async (request, reply) => {
    const itemId = parseContextItemId(request.params);
    if (!itemId) {
      return respondBadRequest(reply, "context item id is required");
    }
    const result = deleteContextItem(services.config, itemId);
    if (!result.deleted) {
      return respondNotFound(reply, "Context item not found");
    }
    return result;
  });

  app.patch("/api/context/items/:itemId", async (request, reply) => {
    const itemId = parseContextItemId(request.params);
    if (!itemId) {
      return respondBadRequest(reply, "context item id is required");
    }
    try {
      const result = updateContextItem(services.config, {
        itemId,
        ...parseContextItemPatchBody(request.body)
      });
      if (!result.item) {
        return respondNotFound(reply, "Context item not found");
      }
      return result;
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.patch("/api/context/items/:itemId/pinned", async (request, reply) => {
    const itemId = parseContextItemId(request.params);
    if (!itemId) {
      return respondBadRequest(reply, "context item id is required");
    }
    const body = parseContextPinnedBody(request.body);
    if (body == null) {
      return respondBadRequest(reply, "pinned boolean is required");
    }
    const result = setContextItemPinned(services.config, itemId, body.pinned);
    if (!result.updated) {
      return respondNotFound(reply, "Context item not found");
    }
    return result;
  });

  app.post("/api/context/items/bulk-delete", async (request, reply) => {
    try {
      const filters = parseContextFilterBody(request.body);
      if (!hasContextFilters(filters)) {
        return respondBadRequest(reply, "at least one context filter is required");
      }
      return bulkDeleteContextItems(services.config, filters);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/context/items/export", async (request, reply) => {
    try {
      return exportContextItems(services.config, parseContextFilterBody(request.body));
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/context/items/import", async (request, reply) => {
    try {
      const jsonl = parseContextImportBody(request.body);
      if (!jsonl) {
        return respondBadRequest(reply, "jsonl is required");
      }
      return importContextItems(services.config, jsonl);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/context/maintenance/compact-user", async (request, reply) => {
    try {
      const body = parseContextCompactBody(request.body);
      if (!body) {
        return respondBadRequest(reply, "userId and olderThanDays are required");
      }
      return compactContextUser(services.config, body);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/context/maintenance/sweep-deleted", async (request, reply) => {
    try {
      return sweepDeletedContextItems(services.config, parseContextSweepDeletedBody(request.body));
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/context/maintenance/clear-embeddings", async (request, reply) => {
    try {
      return clearContextEmbeddings(services.config, parseContextFilterBody(request.body));
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/context/maintenance/reset-index", async (request, reply) => {
    try {
      return resetContextIndex(services.config, parseContextResetIndexBody(request.body));
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/context/maintenance/rebuild-index", async (request, reply) => {
    try {
      return await rebuildContextIndex(services.config, parseContextRebuildIndexBody(request.body));
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/sessions", async () => listSessions(services.config));
  app.get("/api/sessions/stream", async (request, reply) => {
    const stream = getSessionListStream(services.config);
    replyWithSseStream(request, reply, stream);
  });
  app.get("/api/session-modes", async () => listAvailableSessionModes());

  app.post("/api/sessions", async (request, reply) => {
    const body = parseCreateSessionBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }
    try {
      return await createWebSession(services.config, body);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/sessions/:sessionId", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    const session = await getSessionDetail(services.config, params.sessionId);
    if (!session) {
      return respondNotFound(reply, "Session not found");
    }
    return session;
  });

  app.patch("/api/sessions/:sessionId/title", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const body = parseUpdateSessionTitleBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }
    try {
      return await updateSessionTitle(services.config, params.sessionId, body);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/sessions/:sessionId/title/regenerate", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    try {
      return await regenerateSessionTitle(services.config, params.sessionId);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/sessions/:sessionId", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    const result = await deleteSession(services.config, params.sessionId);
    if (!result.ok) {
      return respondNotFound(reply, "Session not found");
    }
    return result;
  });

  app.patch("/api/sessions/:sessionId/mode", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const body = parseSwitchSessionModeBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }
    try {
      return await switchSessionMode(services.config, params.sessionId, body);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.patch("/api/sessions/:sessionId/mode-state", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const body = parseUpdateSessionModeStateBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }
    try {
      return await updateSessionModeState(services.config, params.sessionId, body);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/persona", async () => getPersona(services.config));

  app.get("/api/whitelist", async () => getWhitelist(services.config));

  app.get("/api/requests", async () => listRequests(services.operations));

  app.get("/api/scheduler/jobs", async () => listScheduledJobs(services.operations));
}

function applyImageCacheHeaders(
  reply: { header: (name: string, value: string) => void; code: (statusCode: number) => void; statusCode: number },
  ifNoneMatch: string | string[] | undefined,
  contentType: string,
  buffer: Buffer
): void {
  if (!contentType.startsWith("image/")) {
    return;
  }

  const etag = `"${createHash("sha1").update(contentType).update(":").update(buffer).digest("hex")}"`;
  reply.header("Cache-Control", "private, max-age=604800");
  reply.header("ETag", etag);

  if (matchesIfNoneMatch(ifNoneMatch, etag)) {
    reply.code(304);
  }
}

function matchesIfNoneMatch(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  const values = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag);
}

function parseContextItemsQuery(query: unknown): {
  userId?: string;
  scope?: string;
  sourceType?: string;
  status?: string;
  limit?: number;
  offset?: number;
} {
  const object = isRecord(query) ? query : {};
  return {
    ...optionalStringField(object, "userId"),
    ...optionalEnumField(object, "scope", ["session", "user", "global", "toolset", "mode"]),
    ...optionalEnumField(object, "sourceType", ["chunk", "summary", "fact", "rule"]),
    ...optionalEnumField(object, "status", ["active", "archived", "deleted", "superseded"]),
    ...optionalIntegerField(object, "limit", 100, 1, 500),
    ...optionalIntegerField(object, "offset", 0, 0, Number.MAX_SAFE_INTEGER)
  };
}

function parseContextItemId(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }
  const itemId = stringValue(params.itemId)?.trim();
  return itemId || null;
}

function parseContextPinnedBody(body: unknown): { pinned: boolean } | null {
  if (!isRecord(body) || typeof body.pinned !== "boolean") {
    return null;
  }
  return { pinned: body.pinned };
}

function parseContextItemPatchBody(body: unknown): {
  title?: string | null;
  text?: string;
  retrievalPolicy?: "always" | "search" | "never";
  status?: "active" | "archived" | "deleted" | "superseded";
  sensitivity?: "normal" | "private" | "secret";
  importance?: number | null;
  pinned?: boolean;
  validTo?: number | null;
  supersededBy?: string | null;
} {
  if (!isRecord(body)) {
    return {};
  }
  const patch: {
    title?: string | null;
    text?: string;
    retrievalPolicy?: "always" | "search" | "never";
    status?: "active" | "archived" | "deleted" | "superseded";
    sensitivity?: "normal" | "private" | "secret";
    importance?: number | null;
    pinned?: boolean;
    validTo?: number | null;
    supersededBy?: string | null;
  } = {};
  if ("title" in body) {
    patch.title = body.title == null ? null : requireBodyString(body.title, "title");
  }
  if ("text" in body) {
    patch.text = requireBodyString(body.text, "text");
  }
  if ("retrievalPolicy" in body) {
    patch.retrievalPolicy = requireBodyEnum(body.retrievalPolicy, "retrievalPolicy", ["always", "search", "never"]);
  }
  if ("status" in body) {
    patch.status = requireBodyEnum(body.status, "status", ["active", "archived", "deleted", "superseded"]);
  }
  if ("sensitivity" in body) {
    patch.sensitivity = requireBodyEnum(body.sensitivity, "sensitivity", ["normal", "private", "secret"]);
  }
  if ("importance" in body) {
    patch.importance = body.importance == null ? null : requireBodyNumber(body.importance, "importance");
  }
  if ("pinned" in body) {
    if (typeof body.pinned !== "boolean") {
      throw new Error("pinned must be boolean");
    }
    patch.pinned = body.pinned;
  }
  if ("validTo" in body) {
    patch.validTo = body.validTo == null ? null : requireBodyNumber(body.validTo, "validTo");
  }
  if ("supersededBy" in body) {
    patch.supersededBy = body.supersededBy == null ? null : requireBodyString(body.supersededBy, "supersededBy");
  }
  return patch;
}

function parseContextFilterBody(body: unknown): {
  userId?: string;
  scope?: string;
  sourceType?: string;
  status?: string;
} {
  const object = isRecord(body) ? body : {};
  return {
    ...optionalStringField(object, "userId"),
    ...optionalEnumField(object, "scope", ["session", "user", "global", "toolset", "mode"]),
    ...optionalEnumField(object, "sourceType", ["chunk", "summary", "fact", "rule"]),
    ...optionalEnumField(object, "status", ["active", "archived", "deleted", "superseded"])
  };
}

function hasContextFilters(filters: {
  userId?: string;
  scope?: string;
  sourceType?: string;
  status?: string;
}): boolean {
  return Boolean(filters.userId || filters.scope || filters.sourceType || filters.status);
}

function parseContextImportBody(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const jsonl = stringValue(body.jsonl)?.trim();
  return jsonl || null;
}

function parseContextCompactBody(body: unknown): {
  userId: string;
  olderThanMs: number;
  maxSourceChunks?: number;
} | null {
  if (!isRecord(body)) {
    return null;
  }
  const userId = stringValue(body.userId)?.trim();
  const olderThanDays = numberValue(body.olderThanDays);
  if (!userId || olderThanDays == null || olderThanDays <= 0) {
    return null;
  }
  const maxSourceChunks = numberValue(body.maxSourceChunks);
  return {
    userId,
    olderThanMs: olderThanDays * 24 * 60 * 60 * 1000,
    ...(maxSourceChunks != null ? { maxSourceChunks: Math.max(1, Math.floor(maxSourceChunks)) } : {})
  };
}

function parseContextSweepDeletedBody(body: unknown): { deletedBeforeMs: number } {
  const object = isRecord(body) ? body : {};
  const deletedBeforeDays = numberValue(object.deletedBeforeDays) ?? 14;
  if (deletedBeforeDays <= 0) {
    throw new Error("deletedBeforeDays must be positive");
  }
  return {
    deletedBeforeMs: deletedBeforeDays * 24 * 60 * 60 * 1000
  };
}

function parseContextResetIndexBody(body: unknown): { userId?: string } | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const userId = stringValue(body.userId)?.trim();
  return userId ? { userId } : undefined;
}

function parseContextRebuildIndexBody(body: unknown): {
  userId?: string;
  forceReembed?: boolean;
  embeddingBatchSize?: number;
} {
  if (!isRecord(body)) {
    return {};
  }
  const userId = stringValue(body.userId)?.trim();
  const forceReembed = typeof body.forceReembed === "boolean" ? body.forceReembed : undefined;
  const embeddingBatchSize = numberValue(body.embeddingBatchSize);
  return {
    ...(userId ? { userId } : {}),
    ...(forceReembed !== undefined ? { forceReembed } : {}),
    ...(embeddingBatchSize != null ? { embeddingBatchSize: Math.max(0, Math.floor(embeddingBatchSize)) } : {})
  };
}

function optionalStringField(object: Record<string, unknown>, key: "userId"): { userId?: string } {
  const value = stringValue(object[key])?.trim();
  return value ? { [key]: value } : {};
}

function optionalEnumField<const T extends string>(
  object: Record<string, unknown>,
  key: "scope" | "sourceType" | "status",
  allowed: readonly T[]
): Partial<Record<typeof key, T>> {
  const value = stringValue(object[key])?.trim();
  if (!value) {
    return {};
  }
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid context ${key}: ${value}`);
  }
  return { [key]: value as T };
}

function optionalIntegerField(
  object: Record<string, unknown>,
  key: "limit" | "offset",
  fallback: number,
  min: number,
  max: number
): Partial<Record<typeof key, number>> {
  const rawValue = stringValue(object[key]);
  if (rawValue == null || rawValue.trim() === "") {
    return {};
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid context ${key}: ${rawValue}`);
  }
  return { [key]: Math.min(Math.max(parsed, min), max) || fallback };
}

function stringValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    return stringValue(value[0]);
  }
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function requireBodyString(value: unknown, field: string): string {
  const text = stringValue(value)?.trim();
  if (!text) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return text;
}

function requireBodyNumber(value: unknown, field: string): number {
  const parsed = numberValue(value);
  if (parsed == null) {
    throw new Error(`${field} must be a number`);
  }
  return parsed;
}

function requireBodyEnum<const T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const text = stringValue(value)?.trim();
  if (!text || !allowed.includes(text as T)) {
    throw new Error(`Invalid ${field}: ${text ?? ""}`);
  }
  return text as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

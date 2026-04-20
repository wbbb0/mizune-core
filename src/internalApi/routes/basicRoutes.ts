import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import {
  createWebSession,
  deleteSession,
  getConfigSummary,
  getHealthStatus,
  getPersona,
  getSessionDetail,
  listAvailableSessionModes,
  listSessions,
  listUsers,
  getWhitelist,
  regenerateSessionTitle,
  switchSessionMode,
  updateSessionModeState,
  updateSessionTitle
} from "../application/basicAdminService.ts";
import { listRequests, listScheduledJobs } from "../application/operationsAdminService.ts";
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

  app.get("/api/sessions", async () => listSessions(services.config));
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

import type { FastifyInstance } from "fastify";
import {
  getConfigSummary,
  getHealthStatus,
  getPersona,
  getSessionDetail,
  listSessions,
  listUsers,
  getWhitelist
} from "../application/basicAdminService.ts";
import { listRequests, listScheduledJobs } from "../application/operationsAdminService.ts";
import {
  parseConfigSaveBody,
  parseConfigValidateBody,
  parseEditorOptionsParams,
  parseEditorResourceParams,
  parseResourceItemParams,
  parseWorkspaceAssetParams,
  parseWorkspaceFileQuery,
  parseWorkspacePathQuery,
  parseOrReply,
  parseSessionParams,
  respondBadRequest,
  respondNotFound
} from "../routeSupport.ts";
import type { InternalApiServices } from "../types.ts";

export function registerBasicRoutes(app: FastifyInstance, services: InternalApiServices): void {
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

  app.get("/api/workspace/items", async (request, reply) => {
    const query = parseWorkspacePathQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      return await services.workspaceAdmin.listItems(query.path);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/workspace/stat", async (request, reply) => {
    const query = parseWorkspacePathQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      return await services.workspaceAdmin.statItem(query.path);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/workspace/file", async (request, reply) => {
    const query = parseWorkspaceFileQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      return await services.workspaceAdmin.readFile(query.path, {
        ...(query.startLine != null ? { startLine: query.startLine } : {}),
        ...(query.endLine != null ? { endLine: query.endLine } : {})
      });
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/workspace/content", async (request, reply) => {
    const query = parseWorkspacePathQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    try {
      const result = await services.workspaceAdmin.readFileContent(query.path);
      reply.type(result.contentType);
      return reply.send(result.buffer);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/workspace/assets", async () => services.workspaceAdmin.listAssets());

  app.get("/api/workspace/assets/:assetId", async (request, reply) => {
    const params = parseWorkspaceAssetParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    try {
      const result = await services.workspaceAdmin.getAsset(params.assetId);
      if (!result.asset) {
        return respondNotFound(reply, "Workspace asset not found");
      }
      return result;
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/workspace/assets/:assetId/content", async (request, reply) => {
    const params = parseWorkspaceAssetParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }

    try {
      const result = await services.workspaceAdmin.readAssetContent(params.assetId);
      if (!result.asset || !result.buffer) {
        return respondNotFound(reply, "Workspace asset not found");
      }

      reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(result.asset.filename || result.asset.assetId)}"`);
      reply.type(result.asset.mimeType || "application/octet-stream");
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

  app.get("/api/persona", async () => getPersona(services.config));

  app.get("/api/whitelist", async () => getWhitelist(services.config));

  app.get("/api/requests", async () => listRequests(services.operations));

  app.get("/api/scheduler/jobs", async () => listScheduledJobs(services.operations));
}

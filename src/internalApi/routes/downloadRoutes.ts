import type { FastifyInstance } from "fastify";
import {
  cancelDownload,
  listDownloads,
  pauseDownload,
  readDownload,
  removeDownload,
  resumeDownload,
  startDownload
} from "../application/downloadAdminService.ts";
import {
  handleBadRequest,
  parseDownloadParams,
  parseDownloadStartBody,
  parseOrReply,
  respondNotFound
} from "../routeSupport.ts";
import type { InternalApiServices } from "../types.ts";

export function registerDownloadRoutes(app: FastifyInstance, services: InternalApiServices["downloadRoutes"]): void {
  app.get("/api/downloads", async () => listDownloads(services));

  app.post("/api/downloads", async (request, reply) => {
    const body = parseDownloadStartBody(request.body);
    if (!parseOrReply(reply, body)) return reply;
    try {
      return { task: await startDownload(services, body) };
    } catch (error) {
      return handleBadRequest(reply, error);
    }
  });

  app.get("/api/downloads/:resourceId", async (request, reply) => {
    const params = parseDownloadParams(request.params);
    if (!parseOrReply(reply, params)) return reply;
    const task = readDownload(services, params);
    return task ? { task } : respondNotFound(reply, "Download task not found");
  });

  for (const [action, handler] of [
    ["pause", pauseDownload],
    ["resume", resumeDownload],
    ["cancel", cancelDownload]
  ] as const) {
    app.post(`/api/downloads/:resourceId/${action}`, async (request, reply) => {
      const params = parseDownloadParams(request.params);
      if (!parseOrReply(reply, params)) return reply;
      try {
        const task = await handler(services, params);
        return task ? { task } : respondNotFound(reply, "Download task not found");
      } catch (error) {
        return handleBadRequest(reply, error);
      }
    });
  }

  app.delete("/api/downloads/:resourceId", async (request, reply) => {
    const params = parseDownloadParams(request.params);
    if (!parseOrReply(reply, params)) return reply;
    try {
      const removed = await removeDownload(services, params);
      return removed ? { ok: true } : respondNotFound(reply, "Download task not found");
    } catch (error) {
      return handleBadRequest(reply, error);
    }
  });
}

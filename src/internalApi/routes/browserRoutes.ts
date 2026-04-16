import type { FastifyInstance } from "fastify";
import { createBrowserAdminService } from "../application/browserAdminService.ts";
import {
  parseBrowserProfileParams,
  parseOrReply,
  respondBadRequest
} from "../routeSupport.ts";
import type { InternalApiServices } from "../types.ts";

export function registerBrowserRoutes(app: FastifyInstance, services: InternalApiServices["browserRoutes"]): void {
  const browser = createBrowserAdminService(services);

  app.get("/api/browser/profiles", async (_request, reply) => {
    try {
      return await browser.listProfiles();
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/browser/profiles/:profileId", async (request, reply) => {
    const params = parseBrowserProfileParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    try {
      return await browser.inspectProfile(params.profileId);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/browser/profiles/:profileId/save", async (request, reply) => {
    const params = parseBrowserProfileParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    try {
      return await browser.saveProfile(params.profileId);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/browser/profiles/:profileId/clear", async (request, reply) => {
    const params = parseBrowserProfileParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    try {
      return await browser.clearProfile(params.profileId);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });
}

import type { FastifyInstance } from "fastify";
import {
  closeShellSession,
  getShellSession,
  interactWithShellSession,
  listShellSessions,
  readShellSession,
  runShellCommand,
  signalShellSession
} from "../application/shellAdminService.ts";
import {
  handleBadRequest,
  parseShellInteractBody,
  parseOrReply,
  parseSessionParams,
  parseShellRunBody,
  parseShellSignalBody,
  respondBadRequest,
  respondNotFound
} from "../routeSupport.ts";
import type { InternalApiServices } from "../types.ts";

export function registerShellRoutes(app: FastifyInstance, services: InternalApiServices): void {
  app.get("/api/shell/sessions", async () => listShellSessions(services.shell));

  app.get("/api/shell/sessions/:sessionId", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const session = getShellSession(services.shell, params);
    if (!session) {
      return respondNotFound(reply, "Shell session not found");
    }
    return { session };
  });

  app.post("/api/shell/run", async (request, reply) => {
    const body = parseShellRunBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }

    try {
      const result = await runShellCommand(services.shell, body);
      return { ok: true, result };
    } catch (error: unknown) {
      return handleBadRequest(reply, error);
    }
  });

  app.post("/api/shell/sessions/:sessionId/interact", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const body = parseShellInteractBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }

    try {
      const result = await interactWithShellSession(services.shell, params, body);
      return { ok: true, ...result };
    } catch (error: unknown) {
      return handleBadRequest(reply, error);
    }
  });

  app.post("/api/shell/sessions/:sessionId/read", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    try {
      const result = await readShellSession(services.shell, params);
      return { ok: true, ...result };
    } catch (error: unknown) {
      return handleBadRequest(reply, error);
    }
  });

  app.post("/api/shell/sessions/:sessionId/signal", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const body = parseShellSignalBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }

    try {
      const session = await signalShellSession(services.shell, params, body);
      return { ok: true, session };
    } catch (error: unknown) {
      return handleBadRequest(reply, error);
    }
  });

  app.post("/api/shell/sessions/:sessionId/close", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    return closeShellSession(services.shell, params);
  });
}

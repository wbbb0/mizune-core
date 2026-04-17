import type { FastifyInstance } from "fastify";
import {
  createAdminMessagingService
} from "../application/messagingAdminService.ts";
import {
  parseSendTextBody,
  parseOrReply,
  parseSessionParams,
  parseTranscriptGroupParams,
  parseTranscriptItemParams,
  parseWebSessionStreamQuery,
  parseWebTurnBody,
  parseWebTurnStreamQuery,
  parseTranscriptQuery,
  respondBadRequest
} from "../routeSupport.ts";
import { replyWithSseStream } from "./sse.ts";
import type { InternalApiServices } from "../types.ts";

export function registerMessagingRoutes(app: FastifyInstance, services: InternalApiServices["messagingRoutes"]): void {
  const messaging = createAdminMessagingService(services);

  app.post("/api/sessions/:sessionId/web-turn", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const body = parseWebTurnBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }

    try {
      return await messaging.startWebSessionTurn(params, body);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/sessions/:sessionId/web-turn/stream", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const query = parseWebTurnStreamQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    let stream;
    try {
      stream = messaging.getWebTurnStream(params, query);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }

    replyWithSseStream(request, reply, stream, {
      isTerminalEvent: (event) => event.type === "complete" || event.type === "turn_error"
    });
  });

  app.get("/api/sessions/:sessionId/stream", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) {
      return reply;
    }
    const query = parseWebSessionStreamQuery(request.query);
    if (!parseOrReply(reply, query)) {
      return reply;
    }

    let stream;
    try {
      stream = await messaging.getWebSessionStream(params, query);
    } catch (error: unknown) {
      // Session not found: send an SSE error event so the client knows to stop
      // retrying, then close. Returning a 400 here causes EventSource to retry
      // silently forever, which is not what we want.
      const message = error instanceof Error ? error.message : String(error);
      replyWithSseStream(request, reply, {
        initialEvents: [{ type: "session_error" as const, message }],
        subscribe: (listener) => { listener({ type: "session_error" as const, message }); return () => {}; }
      }, {
        isTerminalEvent: (e) => e.type === "session_error"
      });
      return reply;
    }

    replyWithSseStream(request, reply, stream);
  });

  app.get("/api/sessions/:sessionId/transcript", async (request, reply) => {
    const params = parseSessionParams(request.params);
    if (!parseOrReply(reply, params)) return reply;
    const query = parseTranscriptQuery(request.query);
    if (!parseOrReply(reply, query)) return reply;
    try {
      return messaging.fetchTranscript(params, query);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/sessions/:sessionId/transcript/items/:itemId", async (request, reply) => {
    const params = parseTranscriptItemParams(request.params);
    if (!parseOrReply(reply, params)) return reply;
    try {
      return await messaging.invalidateTranscriptItem(params);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/sessions/:sessionId/transcript/groups/:groupId", async (request, reply) => {
    const params = parseTranscriptGroupParams(request.params);
    if (!parseOrReply(reply, params)) return reply;
    try {
      return await messaging.invalidateTranscriptGroup(params);
    } catch (error: unknown) {
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/send-text", async (request, reply) => {
    const body = parseSendTextBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }

    const result = await messaging.sendInternalTextMessage(body);
    return { ok: true, result };
  });
}

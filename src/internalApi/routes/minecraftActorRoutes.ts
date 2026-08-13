import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  getMinecraftActorDetail,
  listMinecraftActors,
  openMinecraftActorStream,
  toPublicMinecraftActorRequest,
  type MinecraftActorStreamEvent
} from "../application/minecraftActorAdminService.ts";
import type { InternalApiServices } from "../types.ts";
import { replyWithSseStream, type SseConnectionRegistry } from "./sse.ts";

const resourceParamsSchema = z.object({ resourceId: z.string().trim().min(1).max(256) }).strict();
const streamQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().optional() }).strict();
const requestBodySchema = z.object({
  instruction: z.string().trim().min(1).max(8_000),
  constraints: z.string().trim().max(4_000).nullable().optional(),
  priority: z.enum(["normal", "high"]).optional(),
  expectedRevision: z.number().int().nonnegative()
}).strict();
const interruptBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1_000).optional()
}).strict();
const closeBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1_000).optional()
}).strict();

export function registerMinecraftActorRoutes(
  app: FastifyInstance,
  services: InternalApiServices["minecraftActorRoutes"],
  sseConnections?: SseConnectionRegistry
): void {
  app.get("/api/minecraft/actors", async () => listMinecraftActors(services));

  app.get("/api/minecraft/actors/:resourceId", async (request, reply) => {
    const params = parseInput(resourceParamsSchema, request.params);
    const actor = await getMinecraftActorDetail(services, params.resourceId);
    if (!actor) return reply.status(404).send({ error: "Minecraft Actor not found" });
    return { actor };
  });

  app.get("/api/minecraft/actors/:resourceId/stream", async (request, reply) => {
    const params = parseInput(resourceParamsSchema, request.params);
    const query = parseInput(streamQuerySchema, request.query);
    const headerCursor = parseCursorHeader(request.headers["last-event-id"]);
    const connectionController = new AbortController();
    const handleDisconnect = () => connectionController.abort(new Error("Minecraft Actor SSE 客户端已断开"));
    const removeDisconnectListeners = () => {
      request.raw.off("aborted", handleDisconnect);
      request.raw.off("close", handleDisconnect);
    };
    request.raw.once("aborted", handleDisconnect);
    request.raw.once("close", handleDisconnect);
    try {
      const stream = await openMinecraftActorStream(
        services,
        params.resourceId,
        query.after ?? headerCursor,
        connectionController.signal
      );
      if (connectionController.signal.aborted || request.raw.destroyed) {
        stream.dispose();
        removeDisconnectListeners();
        return reply;
      }
      replyWithSseStream<MinecraftActorStreamEvent>(request, reply, {
        initialEvents: stream.initialEvents,
        subscribe(listener) {
          const unsubscribe = stream.subscribe(listener);
          return () => {
            unsubscribe();
            stream.dispose();
            removeDisconnectListeners();
          };
        }
      }, {
        eventId: event => event.id,
        heartbeatMs: 15_000,
        maxBufferedEvents: 1_024,
        isTerminalEvent: event => event.type === "actor_terminal" || event.type === "actor_reconnect",
        ...(sseConnections ? { connectionRegistry: sseConnections } : {})
      });
      return reply;
    } catch (error) {
      removeDisconnectListeners();
      if (connectionController.signal.aborted || request.raw.destroyed) return reply;
      throw error;
    }
  });

  app.post("/api/minecraft/actors/:resourceId/requests", async (request, reply) => {
    requireSameOrigin(request);
    const params = parseInput(resourceParamsSchema, request.params);
    const body = parseInput(requestBodySchema, request.body);
    const owner = await requireAdminControllableActor(services, params.resourceId);
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    const result = await services.minecraftActorManager.request(params.resourceId, {
      ownerPrincipalId: owner.ownerPrincipalId,
      ownerSessionId: owner.ownerSessionId,
      idempotencyKey,
      instruction: body.instruction,
      ...(body.constraints === undefined ? {} : { constraints: body.constraints }),
      ...(body.priority === undefined ? {} : { priority: body.priority }),
      expectedRevision: body.expectedRevision
    });
    void services.minecraftActorManager.processMailbox(params.resourceId).catch(() => undefined);
    return reply.status(result.replayed ? 200 : 202).send({
      ok: true,
      replayed: result.replayed,
      request: toPublicMinecraftActorRequest(result.request),
      revision: result.revision
    });
  });

  app.post("/api/minecraft/actors/:resourceId/interrupt", async (request, reply) => {
    requireSameOrigin(request);
    const params = parseInput(resourceParamsSchema, request.params);
    const body = parseInput(interruptBodySchema, request.body);
    const owner = await requireAdminControllableActor(services, params.resourceId);
    const result = await services.minecraftActorManager.interrupt(params.resourceId, {
      ownerPrincipalId: owner.ownerPrincipalId,
      ownerSessionId: owner.ownerSessionId,
      expectedRevision: body.expectedRevision,
      ...(body.reason === undefined ? {} : { reason: body.reason })
    });
    return { ok: true, ...result };
  });

  app.post("/api/minecraft/actors/:resourceId/close", async (request, reply) => {
    requireSameOrigin(request);
    const params = parseInput(resourceParamsSchema, request.params);
    const body = parseInput(closeBodySchema, request.body);
    const owner = await requireAdminControllableActor(services, params.resourceId);
    await services.minecraftActorManager.close(
      params.resourceId,
      body.reason ?? "webui_closed",
      { ownerPrincipalId: owner.ownerPrincipalId, expectedRevision: body.expectedRevision }
    );
    return { ok: true };
  });
}

// WebUI 使用单一管理员认证而不是逐用户账号；这里显式执行管理员控制能力，
// ownerPrincipalId 仅用于让领域层继续校验资源归属，不能由浏览器自行声明。
async function requireAdminControllableActor(
  services: InternalApiServices["minecraftActorRoutes"],
  resourceId: string
): Promise<{ ownerPrincipalId: string; ownerSessionId: string }> {
  const [resource, state] = await Promise.all([
    services.minecraftActorManager.get(resourceId),
    services.minecraftActorControlStore.getControlState(resourceId)
  ]);
  if (!resource || !state || resource.status !== "active") {
    throw Object.assign(new Error(`Minecraft Actor 资源不可控制：${resourceId}`), { statusCode: 404 });
  }
  return {
    ownerPrincipalId: state.ownerPrincipalId,
    ownerSessionId: resource.ownerSessionId ?? state.ownerPrincipalId
  };
}

function parseIdempotencyKey(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) {
    throw Object.assign(new Error("缺少必需的 Idempotency-Key"), { statusCode: 428 });
  }
  const normalized = raw.trim();
  if (!normalized || normalized.length > 252) {
    throw Object.assign(new Error("Idempotency-Key 必须是 1 到 252 个字符"), { statusCode: 400 });
  }
  return `web:${normalized}`;
}

function parseCursorHeader(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "") return null;
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw Object.assign(new Error("Last-Event-ID 不是有效游标"), { statusCode: 400 });
  }
  return cursor;
}

function requireSameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers.host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw Object.assign(new Error("Origin 无效"), { statusCode: 403 });
  }
  if (!host || originHost !== host) {
    throw Object.assign(new Error("拒绝跨来源 Minecraft Actor 控制请求"), { statusCode: 403 });
  }
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw Object.assign(new Error(parsed.error.issues[0]?.message ?? "请求参数无效"), { statusCode: 400 });
}

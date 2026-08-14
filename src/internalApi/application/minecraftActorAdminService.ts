import type { RuntimeResourceRecord } from "#runtime/resources/resourceTypes.ts";
import type {
  MinecraftActorControlState,
  MinecraftActorJournalEvent,
  MinecraftActorRequestRecord
} from "#services/minecraft/actorControlStore.ts";
import type { JsonValue, MinecraftActorSnapshot } from "#services/minecraft/actorTypes.ts";
import type { InternalApiMinecraftActorDeps } from "../types.ts";

const MAX_STREAM_REPLAY_EVENTS = 2_048;
const MAX_STREAM_INITIAL_BUFFER_EVENTS = 4_096;
const PUBLIC_FAILURE_SUMMARY = "Actor 执行未成功，请查看服务端日志";

export interface MinecraftActorPublicSummary {
  resourceId: string;
  actorId: string;
  title: string | null;
  description: string | null;
  summary: string;
  resourceStatus: RuntimeResourceRecord["status"];
  serverAddress: string;
  backend: "simulation" | "neoforge";
  provisionStatus: "pending" | "running" | "ready" | "needs_attention" | "retry_wait" | "failed" | "stopped";
  provisionPhase: string;
  provisionFailureCode: string | null;
  currentGoal: string | null;
  loopPhase: MinecraftActorControlState["loopPhase"] | "unavailable";
  revision: number;
  lastError: string | null;
  updatedAtMs: number;
}

export interface MinecraftActorPublicDetail extends MinecraftActorPublicSummary {
  persistentState: string;
  runtimeSnapshot: MinecraftActorSnapshot | null;
  runtimeError: string | null;
  requests: MinecraftActorPublicRequest[];
  timeline: MinecraftActorJournalEvent[];
  capabilities: {
    canRequest: boolean;
    canInterrupt: boolean;
    canClose: boolean;
    canEmergencyStop: false;
    programValidationSupported: boolean;
    programExecutionSupported: false;
  };
}

export type MinecraftActorPublicRequest = Omit<
  MinecraftActorRequestRecord,
  "idempotencyKey" | "ownerPrincipalId" | "ownerSessionId"
>;

export type MinecraftActorStreamEvent =
  | { type: "actor_snapshot" | "actor_reset"; id: number; actor: MinecraftActorPublicDetail }
  | { type: "actor_resume"; id: number; actor: MinecraftActorPublicSummary; requests: MinecraftActorPublicRequest[] }
  | { type: "actor_event"; id: number; event: MinecraftActorJournalEvent }
  | { type: "actor_reconnect"; id: number; reason: "initial_buffer_overflow" }
  | {
      type: "actor_terminal";
      id: number;
      resourceId: string;
      resourceStatus: Exclude<RuntimeResourceRecord["status"], "active">;
    };

export interface MinecraftActorStream {
  initialEvents: MinecraftActorStreamEvent[];
  subscribe(listener: (event: MinecraftActorStreamEvent) => void): () => void;
  dispose(): void;
}

export async function listMinecraftActors(
  deps: InternalApiMinecraftActorDeps
): Promise<{ actors: MinecraftActorPublicSummary[] }> {
  const resources = await deps.minecraftActorManager.list();
  const actors = await Promise.all(resources.map(async resource => {
    const state = await deps.minecraftActorControlStore.getControlState(resource.resourceId);
    return toPublicSummary(resource, state);
  }));
  return { actors };
}

export async function getMinecraftActorDetail(
  deps: InternalApiMinecraftActorDeps,
  resourceId: string,
  signal?: AbortSignal
): Promise<MinecraftActorPublicDetail | null> {
  const initialResource = await deps.minecraftActorManager.get(resourceId);
  if (!initialResource) return null;
  const [requests, timeline, runtime] = await Promise.all([
    deps.minecraftActorControlStore.listRequests(resourceId, 100),
    deps.minecraftActorControlStore.listRecentEvents(resourceId, 100),
    probeRuntime(deps, initialResource, signal)
  ]);
  const [resource, state] = await Promise.all([
    deps.minecraftActorManager.get(resourceId),
    deps.minecraftActorControlStore.getControlState(resourceId)
  ]);
  if (!resource) return null;
  const runtimeSnapshot = resource.status === "active" ? runtime.snapshot : null;
  const runtimeError = resource.status === "active" ? runtime.error : null;
  return {
    ...toPublicSummary(resource, state),
    persistentState: resource.minecraftActor?.persistentState ?? "",
    runtimeSnapshot,
    runtimeError,
    requests: requests.map(toPublicMinecraftActorRequest),
    timeline: timeline.map(toPublicJournalEvent),
    capabilities: {
      canRequest: resource.status === "active",
      canInterrupt: resource.status === "active" && state?.loopPhase === "deciding",
      canClose: resource.status === "active",
      canEmergencyStop: false,
      programValidationSupported: resource.status === "active"
        && resource.minecraftActor?.binding.provisionStatus === "ready"
        && resource.minecraftActor?.allowProgramDeployment === true,
      programExecutionSupported: false
    }
  };
}

export async function openMinecraftActorStream(
  deps: InternalApiMinecraftActorDeps,
  resourceId: string,
  requestedCursor: number | null,
  signal?: AbortSignal
): Promise<MinecraftActorStream> {
  throwIfAborted(signal);
  const resource = await deps.minecraftActorManager.get(resourceId);
  if (!resource) throw notFound(`Minecraft Actor 不存在：${resourceId}`);

  const pendingLive: MinecraftActorJournalEvent[] = [];
  let liveListener: ((event: MinecraftActorStreamEvent) => void) | null = null;
  let disposed = false;
  let initialBufferOverflowed = false;
  let unsubscribeJournal = () => {};
  const handleAbort = () => dispose();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    liveListener = null;
    pendingLive.length = 0;
    unsubscribeJournal();
    signal?.removeEventListener("abort", handleAbort);
  };
  signal?.addEventListener("abort", handleAbort, { once: true });
  if (signal?.aborted) {
    dispose();
    throw abortError(signal);
  }
  unsubscribeJournal = deps.minecraftActorControlStore.subscribe(event => {
    if (disposed || event.resourceId !== resourceId) return;
    if (liveListener) liveListener(toStreamJournalEvent(event));
    else if (pendingLive.length < MAX_STREAM_INITIAL_BUFFER_EVENTS) pendingLive.push(event);
    else initialBufferOverflowed = true;
  });

  try {
    const bounds = await deps.minecraftActorControlStore.getEventBounds(resourceId);
    throwIfAborted(signal);
    const cursorInBounds = requestedCursor !== null
      && requestedCursor >= 0
      && requestedCursor <= bounds.lastEventId
      && (bounds.firstEventId === 0 || requestedCursor >= bounds.firstEventId - 1);
    const replay = cursorInBounds && requestedCursor !== 0
      ? await listEventsUpTo(
          deps,
          resourceId,
          requestedCursor,
          bounds.lastEventId,
          MAX_STREAM_REPLAY_EVENTS + 1
        )
      : [];
    const canResume = cursorInBounds && replay.length <= MAX_STREAM_REPLAY_EVENTS;
    let initialEvents: MinecraftActorStreamEvent[];
    if (canResume && requestedCursor !== 0) {
      const [current, requests] = await Promise.all([
        deps.minecraftActorManager.get(resourceId),
        deps.minecraftActorControlStore.listRequests(resourceId, 100)
      ]);
      if (!current) throw notFound(`Minecraft Actor 不存在：${resourceId}`);
      const state = await deps.minecraftActorControlStore.getControlState(resourceId);
      initialEvents = [
        {
          type: "actor_resume",
          id: requestedCursor,
          actor: toPublicSummary(current, state),
          requests: requests.map(toPublicMinecraftActorRequest)
        },
        ...replay.map(toStreamJournalEvent)
      ];
    } else {
      const detail = await getMinecraftActorDetail(deps, resourceId, signal);
      if (!detail) throw notFound(`Minecraft Actor 不存在：${resourceId}`);
      initialEvents = [{
        type: requestedCursor === null || requestedCursor === 0 ? "actor_snapshot" : "actor_reset",
        id: bounds.lastEventId,
        actor: detail
      }];
    }
    throwIfAborted(signal);

    const current = await deps.minecraftActorManager.get(resourceId);
    if (!current) throw notFound(`Minecraft Actor 不存在：${resourceId}`);
    const terminalStatus = current.status === "active" ? null : current.status;

    const highWater = bounds.lastEventId;
    return {
      initialEvents,
      subscribe(listener) {
        if (disposed) return () => {};
        liveListener = listener;
        if (initialBufferOverflowed) {
          listener({ type: "actor_reconnect", id: highWater, reason: "initial_buffer_overflow" });
          dispose();
          return () => {};
        }
        const buffered = pendingLive
          .filter(event => event.eventId > highWater)
          .sort((left, right) => left.eventId - right.eventId);
        pendingLive.length = 0;
        let terminalDelivered = false;
        for (const event of buffered) {
          const projected = toStreamJournalEvent(event);
          listener(projected);
          if (projected.type === "actor_terminal") terminalDelivered = true;
        }
        if (terminalStatus && !terminalDelivered) {
          listener({
            type: "actor_terminal",
            id: Math.max(highWater, buffered.at(-1)?.eventId ?? 0),
            resourceId,
            resourceStatus: terminalStatus
          });
        }
        return dispose;
      },
      dispose
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

function toPublicSummary(
  resource: RuntimeResourceRecord,
  state: MinecraftActorControlState | null
): MinecraftActorPublicSummary {
  if (resource.kind !== "minecraft_actor" || !resource.minecraftActor) {
    throw new Error(`资源不是 Minecraft Actor：${resource.resourceId}`);
  }
  return {
    resourceId: resource.resourceId,
    actorId: resource.minecraftActor.actorId,
    title: resource.title,
    description: resource.description,
    summary: resource.summary,
    resourceStatus: resource.status,
    serverAddress: resource.minecraftActor.binding.serverAddress,
    backend: resource.minecraftActor.binding.backend,
    provisionStatus: resource.minecraftActor.binding.provisionStatus,
    provisionPhase: resource.minecraftActor.binding.provisionPhase,
    provisionFailureCode: resource.minecraftActor.binding.failureCode,
    currentGoal: resource.minecraftActor.currentGoal,
    loopPhase: state?.loopPhase ?? "unavailable",
    revision: state?.revision ?? 0,
    lastError: state?.lastError ? PUBLIC_FAILURE_SUMMARY : null,
    updatedAtMs: Math.max(resource.lastAccessedAtMs, state?.updatedAtMs ?? 0)
  };
}

async function probeRuntime(
  deps: InternalApiMinecraftActorDeps,
  resource: RuntimeResourceRecord,
  signal?: AbortSignal
): Promise<{ snapshot: MinecraftActorSnapshot | null; error: string | null }> {
  if (
    resource.status !== "active"
    || resource.minecraftActor?.binding.provisionStatus !== "ready"
  ) return { snapshot: null, error: null };
  try {
    return { snapshot: await deps.minecraftActorManager.probe(resource.resourceId, signal), error: null };
  } catch {
    throwIfAborted(signal);
    return { snapshot: null, error: "Minecraft Runtime 暂时不可用" };
  }
}

async function listEventsUpTo(
  deps: InternalApiMinecraftActorDeps,
  resourceId: string,
  afterEventId: number,
  highWater: number,
  limit: number
): Promise<MinecraftActorJournalEvent[]> {
  const events: MinecraftActorJournalEvent[] = [];
  let cursor = afterEventId;
  while (cursor < highWater && events.length < limit) {
    const page = await deps.minecraftActorControlStore.listEvents(resourceId, cursor, 256);
    if (page.length === 0) break;
    for (const event of page) {
      if (event.eventId <= highWater) events.push(event);
      if (events.length >= limit) break;
    }
    cursor = page.at(-1)!.eventId;
  }
  return events;
}

function toStreamJournalEvent(event: MinecraftActorJournalEvent): MinecraftActorStreamEvent {
  return event.eventType === "actor_closed"
    ? {
        type: "actor_terminal",
        id: event.eventId,
        resourceId: event.resourceId,
        resourceStatus: "closed"
      }
    : { type: "actor_event", id: event.eventId, event: toPublicJournalEvent(event) };
}

export function toPublicMinecraftActorRequest(request: MinecraftActorRequestRecord): MinecraftActorPublicRequest {
  const { idempotencyKey: _idempotencyKey, ownerPrincipalId: _ownerPrincipalId, ownerSessionId: _ownerSessionId, ...publicRequest } = request;
  return {
    ...publicRequest,
    error: publicRequest.error ? PUBLIC_FAILURE_SUMMARY : null
  };
}

function toPublicJournalEvent(event: MinecraftActorJournalEvent): MinecraftActorJournalEvent {
  return {
    ...event,
    payload: sanitizePublicJson(event.payload)
  };
}

function sanitizePublicJson(value: JsonValue, key = ""): JsonValue {
  if (/(?:authorization|password|secret|token|endpoint|socket|ownerPrincipal|ownerSession|modelRefs?|error|stack|reason)/iu.test(key)) {
    return key.toLowerCase().includes("error") ? PUBLIC_FAILURE_SUMMARY : "[已隐藏]";
  }
  if (Array.isArray(value)) return value.map(item => sanitizePublicJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizePublicJson(entryValue, entryKey)
      ])
    );
  }
  if (
    typeof value === "string"
    && /(?:\bBearer\b|\bAuthorization\b|\bconnect\s+E[A-Z]+\b|(?:^|\s)\/(?:home|tmp|run)\/|\.sock\b)/iu.test(value)
  ) {
    return "[已隐藏]";
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error("Minecraft Actor SSE 已取消");
  error.name = "AbortError";
  return error;
}

function notFound(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 404 });
}

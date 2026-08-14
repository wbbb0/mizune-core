import { computed, ref } from "vue";
import { useWorkbenchNavigation } from "@workbench-kit/vue";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";
import { useResourceSelection } from "@/composables/sections/resourceSelection";
import {
  minecraftActorsApi,
  type MinecraftActorDetail,
  type MinecraftActorJournalEvent,
  type MinecraftActorRequest,
  type MinecraftActorStreamEvent,
  type MinecraftActorSummary
} from "@/api/minecraftActors";

const actors = ref<MinecraftActorSummary[]>([]);
const activeActor = ref<MinecraftActorDetail | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const streamStatus = ref<"idle" | "connecting" | "connected" | "error">("idle");
const lastEventId = ref<number | null>(null);

let eventSource: EventSource | null = null;
let reconnectTimer: number | null = null;
let reconnectDelayMs = 1_000;

export const useMinecraftActors = createSharedSectionState(() => {
  const navigation = useWorkbenchNavigation();
  const selection = useResourceSelection();
  const selectedActorId = computed(() =>
    selection.selectedResource.value?.kind === "minecraft_actor"
      ? selection.selectedResource.value.id
      : null
  );

  function resetState() {
    closeStream();
    actors.value = [];
    activeActor.value = null;
    loading.value = false;
    busy.value = false;
    error.value = null;
    streamStatus.value = "idle";
    lastEventId.value = null;
  }

  async function refreshActors() {
    loading.value = true;
    error.value = null;
    try {
      const result = await minecraftActorsApi.list();
      actors.value = result.actors.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      const selectedId = selectedActorId.value;
      if (selectedId && !actors.value.some(actor => actor.resourceId === selectedId)) {
        closeStream();
        activeActor.value = null;
        selection.clearResourceSelection();
      } else if (!selection.selectedResource.value && actors.value[0]) {
        void selectActor(actors.value[0].resourceId);
      }
    } catch (refreshError) {
      error.value = errorMessage(refreshError);
    } finally {
      loading.value = false;
    }
  }

  async function selectActor(resourceId: string) {
    if (selectedActorId.value === resourceId && activeActor.value?.resourceId === resourceId) {
      navigation.showArea("mainArea");
      return;
    }
    selection.selectResource({ kind: "minecraft_actor", id: resourceId });
    navigation.showArea("mainArea");
    closeStream();
    activeActor.value = null;
    lastEventId.value = null;
    streamStatus.value = "connecting";
    try {
      const result = await minecraftActorsApi.detail(resourceId);
      if (selectedActorId.value !== resourceId) return;
      applyDetail(result.actor);
      openStream(resourceId, null);
    } catch (selectError) {
      if (selectedActorId.value === resourceId) {
        error.value = errorMessage(selectError);
        streamStatus.value = "error";
      }
    }
  }

  async function refreshActorDetail(resourceId = selectedActorId.value) {
    if (!resourceId) return;
    error.value = null;
    try {
      const result = await minecraftActorsApi.detail(resourceId);
      if (selectedActorId.value !== resourceId) return;
      applyDetail(result.actor);
    } catch (refreshError) {
      if (selectedActorId.value === resourceId) error.value = errorMessage(refreshError);
      throw refreshError;
    }
  }

  async function submitRequest(input: {
    instruction: string;
    constraints?: string | null;
    priority?: "normal" | "high";
  }) {
    busy.value = true;
    error.value = null;
    try {
      const actor = requireActiveActor();
      const result = await minecraftActorsApi.request(actor.resourceId, {
        ...input,
        expectedRevision: actor.revision,
        idempotencyKey: crypto.randomUUID()
      });
      actor.revision = result.revision;
      actor.loopPhase = "queued";
      upsertRequest(result.request);
      upsertSummary(actor);
    } catch (submitError) {
      error.value = errorMessage(submitError);
      throw submitError;
    } finally {
      busy.value = false;
    }
  }

  async function interrupt(reason = "webui_owner_interrupt") {
    busy.value = true;
    error.value = null;
    try {
      const actor = requireActiveActor();
      await minecraftActorsApi.interrupt(actor.resourceId, {
        expectedRevision: actor.revision,
        reason
      });
    } catch (interruptError) {
      error.value = errorMessage(interruptError);
      throw interruptError;
    } finally {
      busy.value = false;
    }
  }

  async function closeActor() {
    busy.value = true;
    error.value = null;
    try {
      const actor = requireActiveActor();
      await minecraftActorsApi.close(actor.resourceId, {
        expectedRevision: actor.revision,
        reason: "webui_closed"
      });
      actor.resourceStatus = "closed";
      actor.loopPhase = "closed";
      actor.capabilities.canRequest = false;
      actor.capabilities.canInterrupt = false;
      actor.capabilities.canClose = false;
      upsertSummary(actor);
      closeStream();
      streamStatus.value = "idle";
    } catch (closeError) {
      error.value = errorMessage(closeError);
      throw closeError;
    } finally {
      busy.value = false;
    }
  }

  function openStream(resourceId: string, after: number | null) {
    closeStream(false);
    streamStatus.value = "connecting";
    const source = minecraftActorsApi.openStream(resourceId, after);
    eventSource = source;
    for (const type of ["actor_snapshot", "actor_reset", "actor_resume", "actor_event", "actor_reconnect", "actor_terminal"] as const) {
      source.addEventListener(type, event => {
        if (eventSource !== source || selectedActorId.value !== resourceId) return;
        try {
          handleStreamEvent(JSON.parse((event as MessageEvent).data) as MinecraftActorStreamEvent);
          if (eventSource === source) {
            streamStatus.value = "connected";
            reconnectDelayMs = 1_000;
          }
        } catch {
          streamStatus.value = "error";
        }
      });
    }
    source.onerror = () => {
      if (eventSource !== source) return;
      source.close();
      eventSource = null;
      streamStatus.value = "error";
      scheduleReconnect(resourceId);
    };
  }

  function handleStreamEvent(event: MinecraftActorStreamEvent) {
    if (lastEventId.value !== null && event.id < lastEventId.value) return;
    lastEventId.value = event.id;
    if (event.type === "actor_snapshot" || event.type === "actor_reset") {
      activeActor.value = event.actor;
      upsertSummary(event.actor);
      return;
    }
    if (event.type === "actor_resume") {
      if (!activeActor.value || activeActor.value.resourceId !== event.actor.resourceId) return;
      Object.assign(activeActor.value, event.actor, { requests: event.requests });
      upsertSummary(event.actor);
      return;
    }
    if (event.type === "actor_terminal") {
      if (activeActor.value?.resourceId === event.resourceId) {
        activeActor.value.resourceStatus = event.resourceStatus;
        activeActor.value.loopPhase = event.resourceStatus === "closed" ? "closed" : "unavailable";
        activeActor.value.capabilities.canRequest = false;
        activeActor.value.capabilities.canInterrupt = false;
        activeActor.value.capabilities.canClose = false;
        upsertSummary(activeActor.value);
      }
      closeStream();
      streamStatus.value = "idle";
      return;
    }
    if (event.type === "actor_reconnect") {
      closeStream();
      const resourceId = selectedActorId.value;
      if (resourceId) scheduleReconnect(resourceId);
      return;
    }
    if (event.type !== "actor_event") return;
    applyJournalEvent(event.event);
  }

  function applyJournalEvent(event: MinecraftActorJournalEvent) {
    const actor = activeActor.value;
    if (!actor || actor.resourceId !== event.resourceId) return;
    if (!actor.timeline.some(item => item.eventId === event.eventId)) {
      actor.timeline.push(event);
      if (actor.timeline.length > 256) actor.timeline.splice(0, actor.timeline.length - 256);
    }
    actor.revision = Math.max(actor.revision, event.actorRevision);
    actor.updatedAtMs = Math.max(actor.updatedAtMs, event.occurredAtMs);
    if (event.eventType === "owner_request_queued") {
      actor.loopPhase = "queued";
      const payload = asRecord(event.payload);
      if (event.requestId && !actor.requests.some(item => item.requestId === event.requestId)) {
        actor.requests.unshift({
          resourceId: actor.resourceId,
          requestId: event.requestId,
          instruction: stringValue(payload.instruction) || "新委派",
          constraints: nullableString(payload.constraints),
          priority: payload.priority === "high" ? "high" : "normal",
          status: "queued",
          decisionId: event.decisionId,
          resultSummary: null,
          error: null,
          createdAtMs: event.occurredAtMs,
          updatedAtMs: event.occurredAtMs,
          startedAtMs: null,
          completedAtMs: null
        });
      }
    } else if (event.eventType === "decision_started") {
      actor.loopPhase = "deciding";
      patchRequest(event.requestId, { status: "running", startedAtMs: event.occurredAtMs, updatedAtMs: event.occurredAtMs });
    } else if (event.eventType === "decision_retry_scheduled") {
      actor.loopPhase = "queued";
      patchRequest(event.requestId, { status: "queued", error: nullableString(asRecord(event.payload).error), updatedAtMs: event.occurredAtMs });
    } else if (event.eventType === "decision_completed") {
      actor.loopPhase = "idle";
      patchRequest(event.requestId, {
        status: "completed",
        resultSummary: nullableString(asRecord(event.payload).summary),
        completedAtMs: event.occurredAtMs,
        updatedAtMs: event.occurredAtMs
      });
    } else if (event.eventType === "actor_provisioning_requested") {
      actor.provisionStatus = "pending";
      actor.provisionPhase = "validating_target";
    } else if (event.eventType === "actor_provisioning_started") {
      actor.provisionStatus = "running";
      actor.provisionPhase = "allocating";
    } else if (event.eventType === "actor_provisioning_progress") {
      const phase = nullableString(asRecord(event.payload).phase);
      if (phase) actor.provisionPhase = phase;
    } else if (event.eventType === "actor_ready") {
      actor.provisionStatus = "ready";
      actor.provisionPhase = "ready";
      actor.provisionFailureCode = null;
      const loopPhase = nullableString(asRecord(event.payload).loopPhase);
      if (loopPhase === "idle" || loopPhase === "queued") actor.loopPhase = loopPhase;
    } else if (event.eventType === "actor_provisioning_failed") {
      actor.provisionStatus = "failed";
      actor.provisionFailureCode = nullableString(asRecord(event.payload).failureCode);
      actor.loopPhase = "paused";
    } else if (event.eventType === "actor_provisioning_stopped") {
      actor.provisionStatus = "stopped";
      actor.provisionFailureCode = null;
      actor.loopPhase = "paused";
    } else if (event.eventType === "decision_failed" || event.eventType === "decision_dead_letter") {
      actor.loopPhase = "error";
      patchRequest(event.requestId, {
        status: "failed",
        error: nullableString(asRecord(event.payload).error),
        completedAtMs: event.occurredAtMs,
        updatedAtMs: event.occurredAtMs
      });
    } else if (event.eventType === "decision_interrupted") {
      actor.loopPhase = "idle";
      patchRequest(event.requestId, { status: "interrupted", completedAtMs: event.occurredAtMs, updatedAtMs: event.occurredAtMs });
    }
    upsertSummary(actor);
  }

  function patchRequest(requestId: string | null, patch: Partial<MinecraftActorRequest>) {
    if (!requestId || !activeActor.value) return;
    const request = activeActor.value.requests.find(item => item.requestId === requestId);
    if (request) Object.assign(request, patch);
  }

  function upsertRequest(request: MinecraftActorRequest) {
    const actor = activeActor.value;
    if (!actor) return;
    const index = actor.requests.findIndex(item => item.requestId === request.requestId);
    if (index >= 0) actor.requests[index] = request;
    else actor.requests.unshift(request);
  }

  function upsertSummary(actor: MinecraftActorSummary) {
    const index = actors.value.findIndex(item => item.resourceId === actor.resourceId);
    const summary: MinecraftActorSummary = {
      resourceId: actor.resourceId,
      actorId: actor.actorId,
      title: actor.title,
      description: actor.description,
      summary: actor.summary,
      resourceStatus: actor.resourceStatus,
      serverAddress: actor.serverAddress,
      backend: actor.backend,
      provisionStatus: actor.provisionStatus,
      provisionPhase: actor.provisionPhase,
      provisionFailureCode: actor.provisionFailureCode,
      currentGoal: actor.currentGoal,
      loopPhase: actor.loopPhase,
      revision: actor.revision,
      lastError: actor.lastError,
      updatedAtMs: actor.updatedAtMs
    };
    if (index >= 0) actors.value[index] = summary;
    else actors.value.unshift(summary);
  }

  function applyDetail(actor: MinecraftActorDetail) {
    const current = activeActor.value;
    if (
      current?.resourceId === actor.resourceId
      && current.revision > actor.revision
    ) {
      current.runtimeSnapshot = actor.runtimeSnapshot;
      current.runtimeError = actor.runtimeError;
      return;
    }
    activeActor.value = actor;
    upsertSummary(actor);
  }

  function scheduleReconnect(resourceId: string) {
    if (reconnectTimer !== null || selectedActorId.value !== resourceId) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (selectedActorId.value === resourceId) {
        openStream(resourceId, lastEventId.value);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15_000);
      }
    }, reconnectDelayMs);
  }

  function closeStream(clearReconnect = true) {
    eventSource?.close();
    eventSource = null;
    if (clearReconnect && reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function requireActiveActor(): MinecraftActorDetail {
    if (!activeActor.value || activeActor.value.resourceStatus !== "active") {
      throw new Error("当前没有可控制的 Minecraft Actor");
    }
    return activeActor.value;
  }

  void refreshActors();

  return {
    actors,
    activeActor,
    selectedActorId,
    loading,
    busy,
    error,
    streamStatus,
    resetState,
    refreshActors,
    refreshActorDetail,
    selectActor,
    submitRequest,
    interrupt,
    closeActor
  };
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
import { projectToolResult, type JsonObject } from "../core/toolResultProjection.ts";

const MAX_RUNTIME_WAIT_MS = 30_000;
const activeRuntimeWaitSessions = new Set<string>();

export const runtimeWaitToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "runtime_wait",
        description: "在当前会话内短暂等待一段时间。等待只作用于当前 session；等待期间如果当前 session 收到用户消息、后台 shell/下载/ComfyUI 事件或其他待处理内部任务，会提前返回且不会消费这些事件。仅用于几十秒内的状态自然变化；更长的延后提醒或定期任务请使用计划任务工具。",
        parameters: {
          type: "object",
          properties: {
            duration_ms: {
              type: "number",
              minimum: 1,
              maximum: MAX_RUNTIME_WAIT_MS,
              description: "等待时长，单位毫秒，最大 30000。"
            },
            reason: {
              type: "string",
              description: "等待原因，便于日志和工具结果说明。"
            }
            // TODO: 暂不开放 wake_on 参数；所有当前 session 的新待处理工作都应唤醒等待，避免模型主动关闭唤醒来源。
          },
          required: ["duration_ms"],
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  }
];

export const runtimeWaitToolHandlers: Record<string, ToolHandler> = {
  async runtime_wait(_toolCall, args, context) {
    const durationMs = normalizeRuntimeWaitDuration(getNumberArg(args, "duration_ms"));
    if ("error" in durationMs) {
      return JSON.stringify(durationMs);
    }

    const sessionId = context.lastMessage.sessionId;
    if (activeRuntimeWaitSessions.has(sessionId)) {
      return JSON.stringify({
        ok: false,
        status: "rejected",
        reason: "wait_already_active",
        message: "当前 session 已有一个 runtime_wait 正在等待。"
      });
    }

    activeRuntimeWaitSessions.add(sessionId);
    try {
      const reason = getStringArg(args, "reason") ?? null;
      const startedAtMs = Date.now();
      const initialSnapshot = readSessionWaitSnapshot(context, sessionId);
      const initialWake = buildRuntimeWaitWakePayload(initialSnapshot, initialSnapshot, {
        sessionId,
        startedAtMs,
        requestedWaitMs: durationMs.value,
        reason
      });
      if (initialWake) {
        return projectRuntimeWaitResult(initialWake);
      }

      const result = await waitForRuntimeWake({
        context,
        sessionId,
        durationMs: durationMs.value,
        startedAtMs,
        initialSnapshot,
        reason
      });
      return projectRuntimeWaitResult(result);
    } finally {
      activeRuntimeWaitSessions.delete(sessionId);
    }
  }
};

interface RuntimeWaitSnapshot {
  pendingMessages: number;
  pendingSteerMessages: number;
  pendingInternalTriggers: number;
  pendingInlineTriggers: number;
  pendingInternalTriggerKinds: string[];
  pendingInlineTriggerKinds: string[];
}

interface RuntimeWaitBasePayload {
  sessionId: string;
  startedAtMs: number;
  reason: string | null;
}

type RuntimeWaitResult = {
  ok: boolean;
  status: "elapsed" | "woken" | "aborted";
  reason: string | null;
  session_id: string;
  requested_wait_ms: number;
  waited_ms: number;
  started_at_ms: number;
  ended_at_ms: number;
  wake_reason?: string;
  pending_work?: {
    user_messages: number;
    steer_messages: number;
    internal_triggers: number;
    inline_triggers: number;
    internal_trigger_kinds: string[];
    inline_trigger_kinds: string[];
  };
  message?: string;
};

function normalizeRuntimeWaitDuration(value: number | undefined): { value: number } | { error: string; max_duration_ms: number } {
  if (!Number.isFinite(value) || value == null) {
    return { error: "duration_ms is required", max_duration_ms: MAX_RUNTIME_WAIT_MS };
  }
  const rounded = Math.round(value);
  if (rounded <= 0) {
    return { error: "duration_ms must be positive", max_duration_ms: MAX_RUNTIME_WAIT_MS };
  }
  if (rounded > MAX_RUNTIME_WAIT_MS) {
    return { error: "duration_ms exceeds max runtime wait", max_duration_ms: MAX_RUNTIME_WAIT_MS };
  }
  return { value: rounded };
}

function projectRuntimeWaitResult(result: RuntimeWaitResult) {
  return projectToolResult({
    toolName: "runtime_wait",
    canonical: result as unknown as JsonObject,
    projection: {
      initial: (canonical) => canonical
    }
  });
}

function readSessionWaitSnapshot(context: Parameters<ToolHandler>[2], sessionId: string): RuntimeWaitSnapshot {
  const session = context.sessionManager.getSession(sessionId);
  const pendingInternalTriggers = Array.isArray(session.pendingInternalTriggers) ? session.pendingInternalTriggers : [];
  const pendingInlineTriggers = Array.isArray(session.pendingInlineTriggers) ? session.pendingInlineTriggers : [];
  return {
    pendingMessages: Array.isArray(session.pendingMessages) ? session.pendingMessages.length : 0,
    pendingSteerMessages: Array.isArray(session.pendingSteerMessages) ? session.pendingSteerMessages.length : 0,
    pendingInternalTriggers: pendingInternalTriggers.length,
    pendingInlineTriggers: pendingInlineTriggers.length,
    pendingInternalTriggerKinds: pendingInternalTriggers.map((trigger) => trigger.kind),
    pendingInlineTriggerKinds: pendingInlineTriggers.map((trigger) => trigger.kind)
  };
}

function buildRuntimeWaitWakePayload(
  initial: RuntimeWaitSnapshot,
  current: RuntimeWaitSnapshot,
  base: RuntimeWaitBasePayload & { requestedWaitMs?: number }
): RuntimeWaitResult | null {
  const userMessages = Math.max(0, current.pendingMessages - initial.pendingMessages);
  const steerMessages = Math.max(0, current.pendingSteerMessages - initial.pendingSteerMessages);
  const internalTriggers = Math.max(0, current.pendingInternalTriggers - initial.pendingInternalTriggers);
  const inlineTriggers = Math.max(0, current.pendingInlineTriggers - initial.pendingInlineTriggers);
  const hasPendingWork = userMessages > 0 || steerMessages > 0 || internalTriggers > 0 || inlineTriggers > 0;
  const hasInitialPendingWork = current === initial && (
    current.pendingMessages > 0
    || current.pendingSteerMessages > 0
    || current.pendingInternalTriggers > 0
    || current.pendingInlineTriggers > 0
  );
  if (!hasPendingWork && !hasInitialPendingWork) {
    return null;
  }

  const endedAtMs = Date.now();
  return {
    ok: true,
    status: "woken",
    reason: base.reason,
    session_id: base.sessionId,
    requested_wait_ms: base.requestedWaitMs ?? 0,
    waited_ms: Math.max(0, endedAtMs - base.startedAtMs),
    started_at_ms: base.startedAtMs,
    ended_at_ms: endedAtMs,
    wake_reason: "session_pending_work",
    pending_work: {
      user_messages: hasInitialPendingWork ? current.pendingMessages : userMessages,
      steer_messages: hasInitialPendingWork ? current.pendingSteerMessages : steerMessages,
      internal_triggers: hasInitialPendingWork ? current.pendingInternalTriggers : internalTriggers,
      inline_triggers: hasInitialPendingWork ? current.pendingInlineTriggers : inlineTriggers,
      internal_trigger_kinds: current.pendingInternalTriggerKinds,
      inline_trigger_kinds: current.pendingInlineTriggerKinds
    },
    message: "等待期间当前 session 出现新的待处理工作；事件仍保留在原队列中，后续推理会按既有流程处理。"
  };
}

async function waitForRuntimeWake(input: {
  context: Parameters<ToolHandler>[2];
  sessionId: string;
  durationMs: number;
  startedAtMs: number;
  initialSnapshot: RuntimeWaitSnapshot;
  reason: string | null;
}): Promise<RuntimeWaitResult> {
  return await new Promise<RuntimeWaitResult>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: () => void = () => {};
    const finish = (result: RuntimeWaitResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      input.context.abortSignal?.removeEventListener("abort", onAbort);
      unsubscribe();
      resolve(result);
    };
    const finishWokenIfNeeded = () => {
      const currentSnapshot = readSessionWaitSnapshot(input.context, input.sessionId);
      const payload = buildRuntimeWaitWakePayload(input.initialSnapshot, currentSnapshot, {
        sessionId: input.sessionId,
        startedAtMs: input.startedAtMs,
        requestedWaitMs: input.durationMs,
        reason: input.reason
      });
      if (payload) {
        finish(payload);
      }
    };
    const onAbort = () => {
      finishWokenIfNeeded();
      if (settled) {
        return;
      }
      const endedAtMs = Date.now();
      finish({
        ok: false,
        status: "aborted",
        reason: input.reason,
        session_id: input.sessionId,
        requested_wait_ms: input.durationMs,
        waited_ms: Math.max(0, endedAtMs - input.startedAtMs),
        started_at_ms: input.startedAtMs,
        ended_at_ms: endedAtMs,
        wake_reason: "generation_aborted",
        message: "当前会话生成已被打断，等待已提前结束。"
      });
    };
    timeout = setTimeout(() => {
      const endedAtMs = Date.now();
      finish({
        ok: true,
        status: "elapsed",
        reason: input.reason,
        session_id: input.sessionId,
        requested_wait_ms: input.durationMs,
        waited_ms: Math.max(0, endedAtMs - input.startedAtMs),
        started_at_ms: input.startedAtMs,
        ended_at_ms: endedAtMs
      });
    }, input.durationMs);
    timeout.unref?.();
    unsubscribe = input.context.sessionManager.subscribeSession(input.sessionId, finishWokenIfNeeded);
    input.context.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (input.context.abortSignal?.aborted) {
      onAbort();
    }
  });
}

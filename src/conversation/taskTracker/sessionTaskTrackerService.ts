import { normalizeTaskTracker } from "./taskTrackerNormalize.ts";
import {
  createEmptySessionTaskTracker,
  type SessionTaskState,
  type SessionTaskStatus,
  type SessionTaskTracker,
  type TaskToolRef
} from "./taskTrackerTypes.ts";
import type { TaskPlannerIntent } from "./taskTrackerPlannerContext.ts";
import type { ToolObservation } from "#conversation/session/toolObservation.ts";
import { classifyToolResultOutcome, parseToolResultObject } from "./toolResultOutcome.ts";

export interface TaskTrackerUserMessage {
  text: string;
}

export interface ObserveUserBatchInput {
  tracker: SessionTaskTracker;
  messages: TaskTrackerUserMessage[];
  hasRunningResources?: boolean | undefined;
  nowMs?: number | undefined;
}

export interface ObserveToolResultInput {
  sessionId: string;
  tracker: SessionTaskTracker;
  toolName: string;
  toolCallId: string;
  content: string;
  canonicalContent?: string | undefined;
  observation?: ToolObservation | undefined;
  args?: Record<string, unknown> | undefined;
  originalRequest?: string | undefined;
  nowMs?: number | undefined;
}

export interface ObserveAssistantFinalResponseInput {
  tracker: SessionTaskTracker;
  text: string;
  nowMs?: number | undefined;
}

export interface ObserveToolLimitCheckpointInput {
  sessionId: string;
  tracker: SessionTaskTracker;
  originalRequest?: string | undefined;
  nowMs?: number | undefined;
}

export interface ObservePlannerTaskIntentInput {
  tracker: SessionTaskTracker;
  intent?: TaskPlannerIntent | undefined;
  hasRunningResources?: boolean | undefined;
  nowMs?: number | undefined;
}

const EXPLICIT_CANCEL_PATTERNS = [
  /取消(这个|当前|刚才)?任务/,
  /不用做了/,
  /别继续了/,
  /放弃吧/,
  /不做了/
];

const AMBIGUOUS_CANCEL_PATTERNS = [
  /算了/,
  /先这样/,
  /等下再说/,
  /不管了/
];

const CONTINUE_PATTERNS = [
  /继续/,
  /接着做/,
  /恢复刚才的任务/
];

const READY_CONFIRM_PATTERNS = [
  /可以了/,
  /没问题/,
  /搞定/,
  /谢谢/
];

const TOPIC_SWITCH_PATTERNS = [
  /先聊(点|些)?别的/,
  /换个话题/,
  /说点别的/,
  /先问(个|下)?别的/,
  /另外问/
];

const USER_INPUT_PATTERNS = [
  /需要你(确认|选择|提供|补充)/,
  /请(确认|选择|提供|补充)/,
  /等你(确认|选择|提供|补充)/,
  /需要.*用户.*(确认|选择|提供|补充)/
];

const WAITING_TOOL_PATTERNS = [
  /后台.*(完成|结束).*继续/,
  /等.*(命令|终端|下载|任务).*(完成|结束)/,
  /完成后.*继续/
];

const WAITING_TERMINAL_NEXT = "等待后台终端完成或继续读取输出。";
const TOOL_LIMIT_CONFIRMATION_NEXT = "等待用户确认是继续当前任务、调整方案还是停止。";

const TASK_TOOL_PREFIXES = [
  "terminal_",
  "filesystem_",
  "asset_document_"
];

const TASK_TOOL_NAMES = new Set([
  "open_page",
  "inspect_page",
  "interact_with_page",
  "capture_screenshot",
  "close_page",
  "download_asset",
  "download_message_file",
  "asset_send_to_chat",
  "filesystem_send_to_chat",
  "web_search",
  "search_web",
  "browser_search",
  "ground_with_google_search",
  "search_with_iqs_lite_advanced"
]);

const BROWSER_TOOL_NAMES = new Set([
  "open_page",
  "inspect_page",
  "interact_with_page",
  "capture_screenshot",
  "close_page",
  "download_asset"
]);

const SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "search_web",
  "browser_search",
  "ground_with_google_search",
  "search_with_iqs_lite_advanced",
  "asset_document_search",
  "filesystem_search"
]);

const MUTATION_TOOL_NAMES = new Set([
  "download_asset",
  "download_message_file",
  "asset_send_to_chat",
  "filesystem_send_to_chat",
  "filesystem_write",
  "filesystem_delete",
  "filesystem_move",
  "filesystem_copy"
]);

export class SessionTaskTrackerService {
  observeUserBatch(input: ObserveUserBatchInput): SessionTaskTracker {
    const tracker = normalizeTaskTracker(input.tracker);
    const restored = restoreParkedTaskForUserMessage(tracker, input.messages, input.nowMs ?? Date.now());
    if (restored) {
      return restored;
    }
    const primary = tracker.primary;
    if (!primary) {
      return tracker;
    }
    const text = normalizeText(input.messages.map((message) => message.text).join("\n"));
    if (!text) {
      return tracker;
    }
    const nowMs = input.nowMs ?? Date.now();

    if (matchesAny(text, CONTINUE_PATTERNS) && ["waiting_user", "suspended", "cancel_confirming", "ready_to_close"].includes(primary.status)) {
      return withPrimary(tracker, {
        ...primary,
        status: "active",
        blockers: primary.blockers.filter((item) => !item.includes("取消") && !item.includes("暂停")),
        next: primary.next.filter((item) => item !== TOOL_LIMIT_CONFIRMATION_NEXT),
        updatedAtMs: nowMs
      });
    }

    if (primary.status === "ready_to_close" && matchesAny(text, READY_CONFIRM_PATTERNS)) {
      return withPrimary(tracker, {
        ...primary,
        status: "completed",
        updatedAtMs: nowMs
      });
    }

    if (matchesAny(text, EXPLICIT_CANCEL_PATTERNS)) {
      if (input.hasRunningResources === true) {
        return withPrimary(tracker, {
          ...primary,
          status: "waiting_user",
          blockers: appendUnique(primary.blockers, "用户要求取消任务，但仍有后台资源可能在运行，需要确认是否停止资源。"),
          next: appendUnique(primary.next, "确认是只取消跟踪，还是同时停止后台终端、下载或浏览器资源。"),
          updatedAtMs: nowMs
        });
      }
      return withPrimary(tracker, {
        ...primary,
        status: "canceled",
        updatedAtMs: nowMs
      });
    }

    if (matchesAny(text, AMBIGUOUS_CANCEL_PATTERNS)) {
      return withPrimary(tracker, {
        ...primary,
        status: "cancel_confirming",
        next: ["确认用户是要暂停、取消，还是稍后继续。"],
        updatedAtMs: nowMs
      });
    }

    if (primary.status === "active" && matchesAny(text, TOPIC_SWITCH_PATTERNS)) {
      return withPrimary(tracker, {
        ...primary,
        status: "suspended",
        updatedAtMs: nowMs
      });
    }

    return tracker;
  }

  observePlannerTaskIntent(input: ObservePlannerTaskIntentInput): SessionTaskTracker {
    const tracker = normalizeTaskTracker(input.tracker);
    const intent = input.intent;
    if (!intent || intent.kind === "none" || intent.kind === "unknown" || intent.confidence === "low") {
      return tracker;
    }
    const nowMs = input.nowMs ?? Date.now();
    if (intent.kind === "restore_parked") {
      return restoreParkedTaskById(tracker, intent.targetTaskId, nowMs) ?? tracker;
    }
    const primary = tracker.primary;
    if (!primary) {
      return tracker;
    }
    if (intent.kind === "continue_current" || intent.kind === "modify_current") {
      if (["waiting_user", "suspended", "cancel_confirming", "ready_to_close"].includes(primary.status)) {
        return withPrimary(tracker, {
          ...primary,
          status: "active",
          blockers: primary.blockers.filter((item) => !item.includes("取消") && !item.includes("暂停")),
          next: primary.next.filter((item) => item !== TOOL_LIMIT_CONFIRMATION_NEXT),
          updatedAtMs: nowMs
        });
      }
      return tracker;
    }
    if (intent.kind === "confirm_completed") {
      if (primary.status !== "ready_to_close") {
        return tracker;
      }
      return withPrimary(tracker, {
        ...primary,
        status: "completed",
        updatedAtMs: nowMs
      });
    }
    if (intent.kind === "pause_current" || intent.kind === "switch_topic" || intent.kind === "start_unrelated_task") {
      if (["active", "waiting_tool", "ready_to_close", "cancel_confirming"].includes(primary.status)) {
        return withPrimary(tracker, {
          ...primary,
          status: "suspended",
          updatedAtMs: nowMs
        });
      }
      return tracker;
    }
    if (intent.kind === "cancel_current") {
      if (input.hasRunningResources !== false) {
        return withPrimary(tracker, {
          ...primary,
          status: "waiting_user",
          blockers: appendUnique(primary.blockers, "用户要求取消任务，但仍有后台资源可能在运行，需要确认是否停止资源。"),
          next: ["确认是只取消跟踪，还是同时停止后台终端、下载或浏览器资源。"],
          updatedAtMs: nowMs
        });
      }
      return withPrimary(tracker, {
        ...primary,
        status: "canceled",
        updatedAtMs: nowMs
      });
    }
    return tracker;
  }

  observeToolResult(input: ObserveToolResultInput): SessionTaskTracker {
    const tracker = normalizeTaskTracker(input.tracker);
    const nowMs = input.nowMs ?? Date.now();
    const parsed = parseToolResultObject(input.canonicalContent ?? input.content);
    const restoredFromParked = restoreParkedTaskForToolResult(tracker, input, parsed, nowMs);
    if (restoredFromParked) {
      const nextPrimary = applyToolObservation(restoredFromParked.primary, {
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        parsed,
        observation: input.observation,
        args: input.args ?? {},
        nowMs
      });
      return normalizeTaskTracker({
        ...restoredFromParked.tracker,
        primary: nextPrimary
      });
    }

    const newTaskAction = resolveNewTaskAction(tracker.primary, input, parsed);
    if (newTaskAction !== "reuse" && !isTaskTool(input.toolName)) {
      return tracker;
    }

    const primary = newTaskAction === "reuse" ? tracker.primary! : createPrimaryTask({
      sessionId: input.sessionId,
      toolName: input.toolName,
      originalRequest: input.originalRequest,
      nowMs
    });
    const nextPrimary = applyToolObservation(primary, {
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      parsed,
      observation: input.observation,
      args: input.args ?? {},
      nowMs
    });
    const parked = newTaskAction === "park" && tracker.primary
      ? addParkedTask(tracker.parked, toParkedTask(tracker.primary, nowMs))
      : tracker.parked;
    return normalizeTaskTracker({
      ...tracker,
      primary: nextPrimary,
      parked
    });
  }

  observeToolLimitCheckpoint(input: ObserveToolLimitCheckpointInput): SessionTaskTracker {
    const tracker = normalizeTaskTracker(input.tracker);
    const nowMs = input.nowMs ?? Date.now();
    const existingPrimary = tracker.primary;
    const primary = !existingPrimary || ["completed", "canceled", "failed"].includes(existingPrimary.status)
      ? createCheckpointTask({
          sessionId: input.sessionId,
          originalRequest: input.originalRequest,
          nowMs
        })
      : existingPrimary;
    return withPrimary(tracker, {
      ...primary,
      status: "waiting_user",
      next: appendUnique(primary.next, TOOL_LIMIT_CONFIRMATION_NEXT),
      updatedAtMs: nowMs
    });
  }

  observeAssistantFinalResponse(input: ObserveAssistantFinalResponseInput): SessionTaskTracker {
    const tracker = normalizeTaskTracker(input.tracker);
    const primary = tracker.primary;
    if (!primary || primary.status !== "active") {
      return tracker;
    }
    const text = normalizeText(input.text);
    if (!text) {
      return tracker;
    }
    const nowMs = input.nowMs ?? Date.now();
    if (matchesAny(text, USER_INPUT_PATTERNS)) {
      return withPrimary(tracker, {
        ...primary,
        status: "waiting_user",
        updatedAtMs: nowMs
      });
    }
    if (matchesAny(text, WAITING_TOOL_PATTERNS)) {
      return withPrimary(tracker, {
        ...primary,
        status: "waiting_tool",
        updatedAtMs: nowMs
      });
    }
    if (primary.blockers.length === 0 && primary.next.length === 0) {
      return withPrimary(tracker, {
        ...primary,
        status: "ready_to_close",
        readyToCloseAtMs: nowMs,
        updatedAtMs: nowMs
      });
    }
    return tracker;
  }
}

export function normalizeSessionTaskTracker(tracker: unknown): SessionTaskTracker {
  return normalizeTaskTracker(tracker);
}

export function applyTransition(tracker: SessionTaskTracker, primary: SessionTaskState | null): SessionTaskTracker {
  return normalizeTaskTracker({
    ...tracker,
    primary
  });
}

function applyToolObservation(
  primary: SessionTaskState,
  input: {
    toolName: string;
    toolCallId: string;
    parsed: Record<string, unknown> | null;
    observation?: ToolObservation | undefined;
    args: Record<string, unknown>;
    nowMs: number;
  }
): SessionTaskState {
  const ref = buildToolRef(input);
  const refs = upsertToolRef(primary.importantToolRefs, ref);
  const base: SessionTaskState = {
    ...primary,
    status: primary.status === "cancel_confirming" ? "active" : primary.status,
    importantToolRefs: refs,
    updatedAtMs: input.nowMs
  };

  if (input.toolName.startsWith("terminal_")) {
    if (classifyToolResultOutcome(input.parsed) === "in_progress") {
      return {
        ...base,
        status: "waiting_tool",
        done: appendUnique(base.done, summarizeDone(input.toolName, input.observation, "终端任务已启动")),
        next: appendUnique(base.next, WAITING_TERMINAL_NEXT)
      };
    }
    if (classifyToolResultOutcome(input.parsed) === "failed") {
      return {
        ...base,
        status: "active",
        blockers: appendUnique(base.blockers, summarizeFailure(input.toolName, input.parsed, input.observation))
      };
    }
    return {
      ...base,
      status: base.status === "waiting_tool" ? "active" : base.status,
      next: base.next.filter((item) => item !== WAITING_TERMINAL_NEXT),
      done: appendUnique(base.done, summarizeDone(input.toolName, input.observation, "终端工具执行成功"))
    };
  }

  if (BROWSER_TOOL_NAMES.has(input.toolName)) {
    if (classifyToolResultOutcome(input.parsed) === "failed") {
      return {
        ...base,
        status: "active",
        blockers: appendUnique(base.blockers, summarizeFailure(input.toolName, input.parsed, input.observation))
      };
    }
    return {
      ...base,
      done: appendUnique(base.done, summarizeDone(input.toolName, input.observation, "浏览器工具执行成功"))
    };
  }

  if (SEARCH_TOOL_NAMES.has(input.toolName)) {
    return {
      ...base,
      done: appendUnique(base.done, summarizeSearch(input))
    };
  }

  if (MUTATION_TOOL_NAMES.has(input.toolName) || input.toolName.startsWith("filesystem_")) {
    if (classifyToolResultOutcome(input.parsed) === "failed") {
      return {
        ...base,
        status: "active",
        blockers: appendUnique(base.blockers, summarizeFailure(input.toolName, input.parsed, input.observation))
      };
    }
    return {
      ...base,
      done: appendUnique(base.done, summarizeDone(input.toolName, input.observation, "副作用工具执行成功"))
    };
  }

  if (classifyToolResultOutcome(input.parsed) === "failed") {
    return {
      ...base,
      status: "active",
      blockers: appendUnique(base.blockers, summarizeFailure(input.toolName, input.parsed, input.observation))
    };
  }
  return {
    ...base,
    done: appendUnique(base.done, summarizeDone(input.toolName, input.observation, "工具执行成功"))
  };
}

function createPrimaryTask(input: {
  sessionId: string;
  toolName: string;
  originalRequest?: string | undefined;
  nowMs: number;
}): SessionTaskState {
  const request = String(input.originalRequest ?? "").trim();
  return {
    taskId: `${input.sessionId}:${input.nowMs}`,
    status: "active",
    objective: request || `继续处理 ${input.toolName} 发起的工具型任务`,
    ...(request ? { originalRequest: request } : {}),
    done: [],
    next: [],
    blockers: [],
    importantToolRefs: [],
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs
  };
}

function createCheckpointTask(input: {
  sessionId: string;
  originalRequest?: string | undefined;
  nowMs: number;
}): SessionTaskState {
  const request = String(input.originalRequest ?? "").trim();
  return {
    taskId: `${input.sessionId}:${input.nowMs}`,
    status: "waiting_user",
    objective: request || "继续当前工具型任务",
    ...(request ? { originalRequest: request } : {}),
    done: [],
    next: [],
    blockers: [],
    importantToolRefs: [],
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs
  };
}

function buildToolRef(input: {
  toolName: string;
  toolCallId: string;
  observation?: ToolObservation | undefined;
  parsed: Record<string, unknown> | null;
  nowMs: number;
}): TaskToolRef {
  return {
    toolCallId: input.toolCallId || `${input.toolName}:${input.nowMs}`,
    toolName: input.toolName,
    ...(input.observation?.summary ? { summary: input.observation.summary } : {}),
    ...(input.observation?.resource ? { resource: input.observation.resource } : {}),
    ...(resolveRefetchHint(input.parsed) ? { refetchHint: resolveRefetchHint(input.parsed)! } : {}),
    ...(input.observation?.pinned ? { pinned: true } : {}),
    createdAtMs: input.nowMs
  };
}

function resolveRefetchHint(parsed: Record<string, unknown> | null): string | null {
  const value = parsed?.refetch_hint ?? parsed?.refetchHint;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function upsertToolRef(refs: TaskToolRef[], ref: TaskToolRef): TaskToolRef[] {
  return [...refs.filter((item) => item.toolCallId !== ref.toolCallId), ref];
}

function withPrimary(tracker: SessionTaskTracker, primary: SessionTaskState): SessionTaskTracker {
  return normalizeTaskTracker({
    ...tracker,
    primary
  });
}

type NewTaskAction = "reuse" | "create" | "park" | "discard";

function resolveNewTaskAction(
  primary: SessionTaskState | null,
  input: ObserveToolResultInput,
  parsed: Record<string, unknown> | null
): NewTaskAction {
  if (!primary) {
    return "create";
  }
  if (["completed", "canceled", "failed"].includes(primary.status)) {
    return "discard";
  }
  if (["waiting_tool", "suspended", "ready_to_close"].includes(primary.status) && !toolResultMatchesTask(primary, input, parsed)) {
    return "park";
  }
  return "reuse";
}

function isTaskTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.has(toolName) || TASK_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function restoreParkedTaskForUserMessage(
  tracker: SessionTaskTracker,
  messages: TaskTrackerUserMessage[],
  nowMs: number
): SessionTaskTracker | null {
  if (tracker.parked.length === 0) {
    return null;
  }
  const text = normalizeText(messages.map((message) => message.text).join("\n"));
  if (!text) {
    return null;
  }
  const index = tracker.parked.findIndex((task) => parkedTaskMatchesText(task, text));
  if (index < 0) {
    return null;
  }
  const parked = tracker.parked[index]!;
  const currentParked = tracker.primary ? [toParkedTask(tracker.primary, nowMs)] : [];
  return normalizeTaskTracker({
    ...tracker,
    primary: parkedToPrimary(parked, "active", nowMs),
    parked: addParkedTasks(tracker.parked.filter((_, itemIndex) => itemIndex !== index), currentParked)
  });
}

function restoreParkedTaskById(
  tracker: SessionTaskTracker,
  taskId: string | undefined,
  nowMs: number
): SessionTaskTracker | null {
  const normalizedTaskId = taskId?.trim();
  if (!normalizedTaskId) {
    return null;
  }
  const index = tracker.parked.findIndex((task) => task.taskId === normalizedTaskId);
  if (index < 0) {
    return null;
  }
  const parked = tracker.parked[index]!;
  const currentParked = tracker.primary ? [toParkedTask(tracker.primary, nowMs)] : [];
  return normalizeTaskTracker({
    ...tracker,
    primary: parkedToPrimary(parked, "active", nowMs),
    parked: addParkedTasks(tracker.parked.filter((_, itemIndex) => itemIndex !== index), currentParked)
  });
}

function restoreParkedTaskForToolResult(
  tracker: SessionTaskTracker,
  input: ObserveToolResultInput,
  parsed: Record<string, unknown> | null,
  nowMs: number
): { tracker: SessionTaskTracker; primary: SessionTaskState } | null {
  const index = tracker.parked.findIndex((task) => parkedTaskMatchesToolResult(task, input, parsed));
  if (index < 0) {
    return null;
  }
  const parked = tracker.parked[index]!;
  const currentParked = tracker.primary ? [toParkedTask(tracker.primary, nowMs)] : [];
  const nextTracker = normalizeTaskTracker({
    ...tracker,
    primary: parkedToPrimary(parked, parked.status, nowMs),
    parked: addParkedTasks(tracker.parked.filter((_, itemIndex) => itemIndex !== index), currentParked)
  });
  return nextTracker.primary ? { tracker: nextTracker, primary: nextTracker.primary } : null;
}

function parkedTaskMatchesText(task: { taskId: string; objective: string }, text: string): boolean {
  const objective = normalizeText(task.objective);
  return text.includes(task.taskId) || objective.length >= 4 && text.includes(objective);
}

function parkedTaskMatchesToolResult(
  task: { importantToolRefs: TaskToolRef[] },
  input: ObserveToolResultInput,
  parsed: Record<string, unknown> | null
): boolean {
  return task.importantToolRefs.some((ref) => ref.toolCallId === input.toolCallId)
    || resourceIdCandidates(input, parsed).some((resourceId) => (
      task.importantToolRefs.some((ref) => ref.resource?.id === resourceId)
    ));
}

function toolResultMatchesTask(
  task: SessionTaskState,
  input: ObserveToolResultInput,
  parsed: Record<string, unknown> | null
): boolean {
  return task.importantToolRefs.some((ref) => ref.toolCallId === input.toolCallId)
    || resourceIdCandidates(input, parsed).some((resourceId) => (
      task.importantToolRefs.some((ref) => ref.resource?.id === resourceId)
    ));
}

function resourceIdCandidates(input: ObserveToolResultInput, parsed: Record<string, unknown> | null): string[] {
  return collectResourceIdCandidates({
    observationResourceId: input.observation?.resource?.id,
    args: input.args,
    parsed
  });
}

function collectResourceIdCandidates(input: {
  observationResourceId?: string | undefined;
  args?: Record<string, unknown> | undefined;
  parsed: Record<string, unknown> | null;
}): string[] {
  const nestedSession = input.parsed?.session;
  const nestedResourceId = nestedSession && typeof nestedSession === "object" && !Array.isArray(nestedSession)
    ? (nestedSession as Record<string, unknown>).resource_id ?? (nestedSession as Record<string, unknown>).resourceId
    : null;
  return [
    input.observationResourceId,
    input.args?.resource_id,
    input.args?.resourceId,
    input.parsed?.resource_id,
    input.parsed?.resourceId,
    nestedResourceId
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function toParkedTask(task: SessionTaskState, nowMs: number) {
  return {
    taskId: task.taskId,
    status: task.status,
    objective: task.objective,
    summary: summarizeParkedTask(task),
    importantToolRefs: task.importantToolRefs.slice(-3),
    updatedAtMs: nowMs
  };
}

function parkedToPrimary(
  task: ReturnType<typeof toParkedTask>,
  status: SessionTaskStatus,
  nowMs: number
): SessionTaskState {
  return {
    taskId: task.taskId,
    status,
    objective: task.objective,
    done: task.summary ? [task.summary] : [],
    next: [],
    blockers: [],
    importantToolRefs: task.importantToolRefs,
    createdAtMs: task.updatedAtMs,
    updatedAtMs: nowMs
  };
}

function summarizeParkedTask(task: SessionTaskState): string {
  return task.blockers.at(-1) ?? task.next.at(-1) ?? task.done.at(-1) ?? `状态=${task.status}`;
}

function addParkedTasks(existing: SessionTaskTracker["parked"], tasks: Array<ReturnType<typeof toParkedTask>>): SessionTaskTracker["parked"] {
  return tasks.reduce((items, task) => addParkedTask(items, task), existing);
}

function addParkedTask(existing: SessionTaskTracker["parked"], task: ReturnType<typeof toParkedTask>): SessionTaskTracker["parked"] {
  const next = [...existing.filter((item) => item.taskId !== task.taskId), task];
  if (next.length <= 2) {
    return next;
  }
  const removableIndex = next.findIndex((item) => ["ready_to_close", "completed", "canceled"].includes(item.status));
  const index = removableIndex >= 0 ? removableIndex : 0;
  return next.filter((_, itemIndex) => itemIndex !== index);
}

function summarizeFailure(toolName: string, parsed: Record<string, unknown> | null, observation?: ToolObservation | undefined): string {
  const exitCode = parsed?.exitCode ?? parsed?.exit_code;
  const error = parsed?.error ?? parsed?.message;
  if (typeof error === "string" && error.trim()) {
    return `${toolName} 失败：${error.trim()}`;
  }
  if (typeof exitCode === "number") {
    return `${toolName} 退出码 ${exitCode}`;
  }
  return observation?.summary ? `${toolName} 失败：${observation.summary}` : `${toolName} 执行失败`;
}

function summarizeDone(toolName: string, observation: ToolObservation | undefined, fallback: string): string {
  return observation?.summary ? `${toolName}: ${observation.summary}` : `${toolName}: ${fallback}`;
}

function summarizeSearch(input: {
  toolName: string;
  parsed: Record<string, unknown> | null;
  args: Record<string, unknown>;
  observation?: ToolObservation | undefined;
}): string {
  const query = String(input.args.query ?? input.args.q ?? input.parsed?.query ?? "").trim();
  const count = resolveResultCount(input.parsed);
  const countText = count == null ? "" : `，返回 ${count} 条结果`;
  return `已搜索${query ? ` ${query}` : ""}${countText}` || summarizeDone(input.toolName, input.observation, "搜索完成");
}

function resolveResultCount(parsed: Record<string, unknown> | null): number | null {
  if (!parsed) {
    return null;
  }
  for (const key of ["results", "items", "data"]) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  const count = parsed.count ?? parsed.total;
  return typeof count === "number" ? count : null;
}

function appendUnique(items: string[], item: string): string[] {
  return items.includes(item) ? items : [...items, item];
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const sessionTaskTrackerService = new SessionTaskTrackerService();

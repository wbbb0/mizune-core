import { createHash } from "node:crypto";
import { normalizeTaskTracker } from "./taskTrackerNormalize.ts";
import {
  createEmptySessionTaskTracker,
  type SessionTaskState,
  type SessionTaskStatus,
  type SessionTaskTracker,
  type TaskEvidenceCheckpoint,
  type TaskToolRef
} from "./taskTrackerTypes.ts";
import type { TaskPlannerIntent } from "./taskTrackerPlannerContext.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { ToolObservation } from "#conversation/session/toolObservation.ts";

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

export interface MaterializeEvidenceBeforeCompressionInput {
  sessionId: string;
  tracker: SessionTaskTracker;
  transcriptItemsToCompress: InternalTranscriptItem[];
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
    const parsed = parseJsonObject(input.canonicalContent ?? input.content);
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

  materializeEvidenceBeforeCompression(input: MaterializeEvidenceBeforeCompressionInput): SessionTaskTracker {
    const tracker = normalizeTaskTracker(input.tracker);
    const evidenceContexts = buildEvidenceTaskContexts(tracker);
    if (evidenceContexts.length === 0) {
      return tracker;
    }
    const nowMs = input.nowMs ?? Date.now();
    let evidence = tracker.evidence;
    for (const item of input.transcriptItemsToCompress) {
      if (item.kind !== "tool_result") {
        continue;
      }
      const parsed = parseJsonObject(item.canonicalContent ?? item.content);
      const context = resolveEvidenceContext({
        contexts: evidenceContexts,
        primaryTaskId: tracker.primary?.taskId ?? null,
        hasParked: tracker.parked.length > 0,
        item,
        parsed
      });
      if (!context) {
        continue;
      }
      const checkpoint = buildEvidenceCheckpoint({
        sessionId: input.sessionId,
        taskId: context.taskId,
        primaryRefs: context.importantToolRefs,
        item,
        parsed,
        nowMs
      });
      if (!checkpoint) {
        continue;
      }
      evidence = [
        ...evidence.filter((existing) => existing.evidenceId !== checkpoint.evidenceId),
        checkpoint
      ];
    }
    return normalizeTaskTracker({
      ...tracker,
      evidence
    });
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
    if (isRunningResult(input.parsed)) {
      return {
        ...base,
        status: "waiting_tool",
        done: appendUnique(base.done, summarizeDone(input.toolName, input.observation, "终端任务已启动")),
        next: appendUnique(base.next, WAITING_TERMINAL_NEXT)
      };
    }
    if (hasToolFailure(input.parsed)) {
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
    if (hasToolFailure(input.parsed)) {
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
    if (hasToolFailure(input.parsed)) {
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

  if (hasToolFailure(input.parsed)) {
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

function buildEvidenceTaskContexts(tracker: SessionTaskTracker): Array<{ taskId: string; importantToolRefs: TaskToolRef[] }> {
  return [
    ...(tracker.primary ? [{
      taskId: tracker.primary.taskId,
      importantToolRefs: tracker.primary.importantToolRefs
    }] : []),
    ...tracker.parked.map((task) => ({
      taskId: task.taskId,
      importantToolRefs: task.importantToolRefs
    }))
  ];
}

function resolveEvidenceContext(input: {
  contexts: Array<{ taskId: string; importantToolRefs: TaskToolRef[] }>;
  primaryTaskId: string | null;
  hasParked: boolean;
  item: Extract<InternalTranscriptItem, { kind: "tool_result" }>;
  parsed: Record<string, unknown> | null;
}): { taskId: string; importantToolRefs: TaskToolRef[] } | null {
  const resourceIds = collectResourceIdCandidates({
    observationResourceId: input.item.observation?.resource?.id,
    parsed: input.parsed
  });
  const matched = input.contexts.find((context) => (
    context.importantToolRefs.some((ref) => ref.toolCallId === input.item.toolCallId)
    || resourceIds.some((resourceId) => context.importantToolRefs.some((ref) => ref.resource?.id === resourceId))
  ));
  if (matched) {
    return matched;
  }
  if (input.hasParked || !input.primaryTaskId) {
    return null;
  }
  return input.contexts.find((context) => context.taskId === input.primaryTaskId) ?? null;
}

function buildEvidenceCheckpoint(input: {
  sessionId: string;
  taskId: string;
  primaryRefs: TaskToolRef[];
  item: Extract<InternalTranscriptItem, { kind: "tool_result" }>;
  parsed: Record<string, unknown> | null;
  nowMs: number;
}): TaskEvidenceCheckpoint | null {
  const { item } = input;
  const ref = input.primaryRefs.find((candidate) => candidate.toolCallId === item.toolCallId);
  const hasReferencedResource = item.observation?.resource !== undefined && ref !== undefined;
  const failure = hasToolFailure(input.parsed);
  const pinned = item.observation?.pinned === true;
  const replayContent = usefulReplayContent(item.observation?.replayContent);
  if (
    !pinned
    && !hasReferencedResource
    && !failure
    && !isEvidenceTool(item.toolName)
    && replayContent == null
  ) {
    return null;
  }

  const contentForHash = item.canonicalContent ?? item.observation?.replayContent ?? item.content;
  const evidenceId = [
    input.sessionId,
    input.taskId,
    item.toolCallId,
    hashContent(contentForHash).slice(0, 16)
  ].join(":");
  const canonical = shouldStoreCanonicalContent(item, input.parsed)
    ? truncateCanonical(item.canonicalContent)
    : null;
  return {
    evidenceId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    toolCallId: item.toolCallId,
    toolName: item.toolName,
    summary: item.observation?.summary ? `${item.toolName}: ${item.observation.summary}` : `${item.toolName}: 工具结果已在压缩前固化`,
    ...(item.observation?.resource ? { resource: item.observation.resource } : {}),
    ...(replayContent != null ? { replayContent } : {}),
    ...(canonical ? { canonicalContent: canonical.content } : {}),
    ...(canonical?.truncated ? { canonicalTruncated: true } : {}),
    contentHash: item.observation?.contentHash || hashContent(contentForHash),
    pinned,
    createdAtMs: input.nowMs
  };
}

function usefulReplayContent(content: string | undefined): string | null {
  const value = String(content ?? "").trim();
  if (!value || value === "{}" || value === "null") {
    return null;
  }
  return value;
}

function isEvidenceTool(toolName: string): boolean {
  return toolName.startsWith("terminal_")
    || BROWSER_TOOL_NAMES.has(toolName)
    || SEARCH_TOOL_NAMES.has(toolName)
    || MUTATION_TOOL_NAMES.has(toolName)
    || toolName.startsWith("filesystem_")
    || toolName.startsWith("download_")
    || toolName.startsWith("send_")
    || toolName.endsWith("_send_to_chat");
}

function shouldStoreCanonicalContent(
  item: Extract<InternalTranscriptItem, { kind: "tool_result" }>,
  parsed: Record<string, unknown> | null
): boolean {
  if (item.canonicalContent === undefined) {
    return false;
  }
  if (item.observation?.pinned === true || hasToolFailure(parsed) || item.observation?.refetchable === false) {
    return true;
  }
  if (MUTATION_TOOL_NAMES.has(item.toolName) || item.toolName.startsWith("download_") || item.toolName.endsWith("_send_to_chat")) {
    return true;
  }
  return item.toolName.startsWith("terminal_") && !isRunningResult(parsed);
}

function truncateCanonical(content: string | undefined): { content: string; truncated: boolean } | null {
  if (content === undefined) {
    return null;
  }
  const limit = 12_000;
  return {
    content: content.length > limit ? content.slice(0, limit) : content,
    truncated: content.length > limit
  };
}

function isRunningResult(parsed: Record<string, unknown> | null): boolean {
  const nestedSession = parsed?.session;
  const nestedStatus = nestedSession && typeof nestedSession === "object" && !Array.isArray(nestedSession)
    ? (nestedSession as Record<string, unknown>).status
    : null;
  return parsed?.status === "running"
    || nestedStatus === "running"
    || nestedStatus === "active"
    || parsed?.running === true;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hasToolFailure(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) {
    return false;
  }
  if (parsed.error || parsed.ok === false || parsed.status === "failed" || parsed.status === "error") {
    return true;
  }
  const exitCode = parsed.exitCode ?? parsed.exit_code;
  return typeof exitCode === "number" && exitCode !== 0;
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

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
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

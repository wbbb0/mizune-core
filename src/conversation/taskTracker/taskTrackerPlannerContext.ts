import type { SessionTaskTracker, SessionTaskStatus } from "./taskTrackerTypes.ts";

export const taskPlannerIntentKinds = [
  "none",
  "continue_current",
  "modify_current",
  "pause_current",
  "cancel_current",
  "confirm_completed",
  "switch_topic",
  "start_unrelated_task",
  "restore_parked",
  "unknown"
] as const;

export const taskPlannerIntentConfidenceValues = ["low", "medium", "high"] as const;

export type TaskPlannerIntentKind = (typeof taskPlannerIntentKinds)[number];
export type TaskPlannerIntentConfidence = (typeof taskPlannerIntentConfidenceValues)[number];

export interface TaskPlannerIntent {
  kind: TaskPlannerIntentKind;
  confidence: TaskPlannerIntentConfidence;
  targetTaskId?: string | undefined;
  reason?: string | undefined;
}

export interface TurnPlannerTaskContext {
  primary?: {
    taskId: string;
    status: SessionTaskStatus;
    objective: string;
    next?: string | undefined;
    blocker?: string | undefined;
  } | undefined;
  parked: Array<{
    taskId: string;
    status: SessionTaskStatus;
    objective: string;
    summary?: string | undefined;
  }>;
}

export function buildTurnPlannerTaskContext(tracker: SessionTaskTracker): TurnPlannerTaskContext | null {
  const primary = tracker.primary && shouldExposePrimaryToPlanner(tracker.primary.status)
    ? tracker.primary
    : null;
  if (!primary && tracker.parked.length === 0) {
    return null;
  }
  return {
    ...(primary
        ? {
            primary: {
              taskId: cap(primary.taskId, 80),
              status: primary.status,
              objective: cap(primary.objective, 180),
              ...(lastNonEmpty(primary.next) ? { next: cap(lastNonEmpty(primary.next)!, 120) } : {}),
              ...(lastNonEmpty(primary.blockers) ? { blocker: cap(lastNonEmpty(primary.blockers)!, 120) } : {})
            }
          }
        : {}),
    parked: tracker.parked.slice(-2).map((task) => ({
      taskId: cap(task.taskId, 80),
      status: task.status,
      objective: cap(task.objective, 140),
      ...(task.summary.trim() ? { summary: cap(task.summary, 100) } : {})
    }))
  };
}

function shouldExposePrimaryToPlanner(status: SessionTaskStatus): boolean {
  return status !== "completed" && status !== "canceled" && status !== "failed";
}

export function parseTaskPlannerIntent(value: unknown): TaskPlannerIntent | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized === "-" || normalized.toLowerCase() === "none") {
    return { kind: "none", confidence: "high" };
  }
  const [kindRaw, targetRaw, confidenceRaw] = normalized.split("|").map((part) => part?.trim() ?? "");
  const kind = normalizeTaskPlannerIntentKind(kindRaw);
  const confidence = normalizeTaskPlannerIntentConfidence(confidenceRaw);
  const targetTaskId = targetRaw && targetRaw !== "-" && targetRaw.toLowerCase() !== "none"
    ? targetRaw
    : undefined;
  return {
    kind,
    confidence,
    ...(targetTaskId ? { targetTaskId: cap(targetTaskId, 80) } : {})
  };
}

export function normalizeTaskPlannerIntent(input: unknown): TaskPlannerIntent | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  const kind = normalizeTaskPlannerIntentKind(value.kind);
  if (kind === "none") {
    return { kind, confidence: "high" };
  }
  const confidence = normalizeTaskPlannerIntentConfidence(value.confidence);
  const target = typeof value.targetTaskId === "string"
    ? value.targetTaskId
    : typeof value.target_task_id === "string"
      ? value.target_task_id
      : "";
  const reason = typeof value.reason === "string" ? value.reason : "";
  return {
    kind,
    confidence,
    ...(target.trim() ? { targetTaskId: cap(target.trim(), 80) } : {}),
    ...(reason.trim() ? { reason: cap(reason.trim(), 80) } : {})
  };
}

function normalizeTaskPlannerIntentKind(input: unknown): TaskPlannerIntentKind {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
  return taskPlannerIntentKinds.includes(normalized as TaskPlannerIntentKind)
    ? normalized as TaskPlannerIntentKind
    : "unknown";
}

function normalizeTaskPlannerIntentConfidence(input: unknown): TaskPlannerIntentConfidence {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
  return taskPlannerIntentConfidenceValues.includes(normalized as TaskPlannerIntentConfidence)
    ? normalized as TaskPlannerIntentConfidence
    : "medium";
}

function lastNonEmpty(items: string[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const value = items[index]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function cap(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

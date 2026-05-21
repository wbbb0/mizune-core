import {
  createEmptySessionTaskTracker,
  sessionTaskTrackerSchema,
  type ParkedTaskState,
  type SessionTaskState,
  type SessionTaskTracker,
  type TaskEvidenceCheckpoint,
  type TaskToolRef
} from "./taskTrackerTypes.ts";

type TaskResourceRef = NonNullable<TaskToolRef["resource"]>;

const MAX_PARKED_TASKS = 2;
const MAX_EVIDENCE = 64;
const MAX_DONE = 12;
const MAX_NEXT = 8;
const MAX_BLOCKERS = 8;
const MAX_IMPORTANT_TOOL_REFS = 12;
const MAX_PARKED_TOOL_REFS = 3;
const MAX_ID_TEXT = 160;
const MAX_HASH_TEXT = 160;
const MAX_TOOL_NAME_TEXT = 120;
const MAX_RESOURCE_LOCATOR_TEXT = 512;
const MAX_SHORT_TEXT = 320;
const MAX_OBJECTIVE_TEXT = 800;
const MAX_EVIDENCE_TEXT = 12_000;

export function normalizeTaskTracker(input: unknown): SessionTaskTracker {
  const parsed = sessionTaskTrackerSchema.safeParse(input);
  const tracker = parsed.success ? parsed.data : createEmptySessionTaskTracker();
  return {
    version: 1,
    primary: tracker.primary ? normalizePrimaryTask(tracker.primary) : null,
    parked: tracker.parked.slice(-MAX_PARKED_TASKS).map(normalizeParkedTask),
    evidence: tracker.evidence.slice(-MAX_EVIDENCE).map(normalizeEvidence)
  };
}

function normalizePrimaryTask(task: SessionTaskState): SessionTaskState {
  return {
    taskId: truncateText(task.taskId, MAX_ID_TEXT),
    status: task.status,
    objective: truncateText(task.objective, MAX_OBJECTIVE_TEXT),
    ...(task.originalRequest !== undefined ? { originalRequest: truncateText(task.originalRequest, MAX_OBJECTIVE_TEXT) } : {}),
    done: normalizeStringList(task.done, MAX_DONE),
    next: normalizeStringList(task.next, MAX_NEXT),
    blockers: normalizeStringList(task.blockers, MAX_BLOCKERS),
    importantToolRefs: normalizeToolRefs(task.importantToolRefs, MAX_IMPORTANT_TOOL_REFS),
    createdAtMs: task.createdAtMs,
    updatedAtMs: task.updatedAtMs,
    ...(task.readyToCloseAtMs !== undefined ? { readyToCloseAtMs: task.readyToCloseAtMs } : {})
  };
}

function normalizeParkedTask(task: ParkedTaskState): ParkedTaskState {
  return {
    taskId: truncateText(task.taskId, MAX_ID_TEXT),
    status: task.status,
    objective: truncateText(task.objective, MAX_OBJECTIVE_TEXT),
    summary: truncateText(task.summary, MAX_SHORT_TEXT),
    importantToolRefs: normalizeToolRefs(task.importantToolRefs, MAX_PARKED_TOOL_REFS),
    updatedAtMs: task.updatedAtMs
  };
}

function normalizeToolRefs(refs: TaskToolRef[], limit: number): TaskToolRef[] {
  const deduped = new Map<string, TaskToolRef>();
  for (const ref of refs) {
    const toolCallId = truncateText(ref.toolCallId, MAX_ID_TEXT);
    deduped.set(toolCallId, {
      toolCallId,
      toolName: truncateText(ref.toolName, MAX_TOOL_NAME_TEXT),
      ...(ref.summary !== undefined ? { summary: truncateText(ref.summary, MAX_SHORT_TEXT) } : {}),
      ...(ref.resource !== undefined ? { resource: normalizeResource(ref.resource) } : {}),
      ...(ref.refetchHint !== undefined ? { refetchHint: truncateText(ref.refetchHint, MAX_SHORT_TEXT) } : {}),
      ...(ref.pinned !== undefined ? { pinned: ref.pinned } : {}),
      ...(ref.createdAtMs !== undefined ? { createdAtMs: ref.createdAtMs } : {})
    });
  }
  return Array.from(deduped.values()).slice(-limit);
}

function normalizeEvidence(item: TaskEvidenceCheckpoint): TaskEvidenceCheckpoint {
  return {
    evidenceId: truncateText(item.evidenceId, MAX_ID_TEXT),
    sessionId: truncateText(item.sessionId, MAX_ID_TEXT),
    taskId: truncateText(item.taskId, MAX_ID_TEXT),
    toolCallId: truncateText(item.toolCallId, MAX_ID_TEXT),
    toolName: truncateText(item.toolName, MAX_TOOL_NAME_TEXT),
    summary: truncateText(item.summary, MAX_SHORT_TEXT),
    ...(item.resource !== undefined ? { resource: normalizeResource(item.resource) } : {}),
    ...(item.replayContent !== undefined ? { replayContent: truncateText(item.replayContent, MAX_EVIDENCE_TEXT) } : {}),
    ...(item.canonicalContent !== undefined ? { canonicalContent: truncateText(item.canonicalContent, MAX_EVIDENCE_TEXT) } : {}),
    ...(item.canonicalTruncated !== undefined ? { canonicalTruncated: item.canonicalTruncated } : {}),
    contentHash: truncateText(item.contentHash, MAX_HASH_TEXT),
    pinned: item.pinned,
    createdAtMs: item.createdAtMs
  };
}

function normalizeResource(resource: TaskResourceRef): TaskResourceRef {
  return {
    kind: resource.kind,
    id: truncateText(resource.id, MAX_ID_TEXT),
    ...(resource.locator !== undefined ? { locator: truncateText(resource.locator, MAX_RESOURCE_LOCATOR_TEXT) } : {}),
    ...(resource.version !== undefined ? { version: truncateText(resource.version, MAX_ID_TEXT) } : {})
  };
}

function normalizeStringList(items: string[], limit: number): string[] {
  return items
    .map((item) => truncateText(item, MAX_SHORT_TEXT).trim())
    .filter(Boolean)
    .slice(-limit);
}

function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

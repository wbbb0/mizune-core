import type { TurnPlannerInput } from "#conversation/turnPlanner/types.ts";
import type { GenerationPromptBuilderDeps } from "./generationRunnerDeps.ts";

type TaskEvidenceInput = Pick<TurnPlannerInput, "sessionId" | "taskContext" | "taskSummary" | "abortSignal"> & {
  source: string;
  recentMessages?: TurnPlannerInput["recentMessages"];
  batchMessages?: TurnPlannerInput["batchMessages"];
};

/** Project task text without treating internal IDs/status as text or mutating persisted state. */
export async function projectPlannerTaskEvidence(
  service: GenerationPromptBuilderDeps["contentSafetyService"],
  input: TaskEvidenceInput
): Promise<{
  taskContext: TurnPlannerInput["taskContext"];
  taskSummary: TurnPlannerInput["taskSummary"];
  recentMessages: TurnPlannerInput["recentMessages"];
  batchMessages: TurnPlannerInput["batchMessages"];
}> {
  input.abortSignal?.throwIfAborted();
  const taskContext = input.taskContext ? {
    ...(input.taskContext.primary ? { primary: { ...input.taskContext.primary } } : {}),
    parked: input.taskContext.parked.map(task => ({ ...task }))
  } : input.taskContext;
  let taskSummary = input.taskSummary;
  const fields: Array<{ text: string; apply: (value: string) => void }> = [];
  if (typeof taskSummary === "string" && taskSummary.trim()) fields.push({ text: taskSummary, apply: value => { taskSummary = value; } });
  if (taskContext?.primary) {
    const primary = taskContext.primary;
    fields.push({ text: primary.objective, apply: value => { primary.objective = value; } });
    if (typeof primary.next === "string") fields.push({ text: primary.next, apply: value => { primary.next = value; } });
    if (typeof primary.blocker === "string") fields.push({ text: primary.blocker, apply: value => { primary.blocker = value; } });
  }
  for (const task of taskContext?.parked ?? []) {
    fields.push({ text: task.objective, apply: value => { task.objective = value; } });
    if (typeof task.summary === "string") fields.push({ text: task.summary, apply: value => { task.summary = value; } });
  }
  const recentMessages = input.recentMessages ?? [];
  const batchMessages = input.batchMessages ?? [];
  if (!service || (!fields.length && !recentMessages.length && !batchMessages.length)) return { taskContext, taskSummary, recentMessages, batchMessages };
  const projected = await service.projectPromptMessages({
    sessionId: input.sessionId, source: input.source,
    recentMessages: [...fields.map(field => ({ role: "user" as const, content: field.text })), ...recentMessages],
    batchMessages, ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
  });
  input.abortSignal?.throwIfAborted();
  if (projected.recentMessages.length !== fields.length + recentMessages.length || projected.batchMessages.length !== batchMessages.length) throw new Error("规划任务证据投影结构无效");
  for (const [index, field] of fields.entries()) {
    const content = projected.recentMessages[index]?.content;
    if (typeof content !== "string") throw new Error("规划任务证据投影缺少文本");
    field.apply(content);
  }
  return { taskContext, taskSummary, recentMessages: projected.recentMessages.slice(fields.length), batchMessages: projected.batchMessages };
}

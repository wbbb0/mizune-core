import type { TurnPlannerResult } from "../conversation/turnPlanner.ts";
import type { SessionTaskState } from "../conversation/taskTracker/taskTrackerTypes.ts";
export function resolveSkillTaskId(input: {
  sessionId: string;
  primary: SessionTaskState | null;
  previousTaskId: string | null;
  planner?: TurnPlannerResult | undefined;
  explicitContinuation: boolean;
  startedAt: number;
}): string {
  if (input.primary && ["active", "waiting_tool", "waiting_user"].includes(input.primary.status))
    return input.primary.taskId;
  const planner = input.planner;
  if (planner?.topicDecisionEvaluated && planner.topicDecision === "new_topic")
    return `topic:${input.sessionId}:${input.startedAt}`;
  const semanticFollowup = planner?.topicDecisionEvaluated && planner.topicDecision === "continue_topic";
  const explicitFollowup = planner?.followupMode != null && planner.followupMode !== "none";
  if (input.previousTaskId && (input.explicitContinuation || semanticFollowup || explicitFollowup))
    return input.previousTaskId;
  return `turn:${input.sessionId}:${input.startedAt}`;
}

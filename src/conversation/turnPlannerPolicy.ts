import type { AppConfig } from "#config/config.ts";
import { areMainModelRoutesEquivalent } from "#llm/shared/modelRouteEquivalence.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { TurnPlannerTaskContext } from "./taskTracker/taskTrackerPlannerContext.ts";

export interface TurnPlannerRequirements {
  modelSelection: boolean;
  toolSelection: boolean;
  replyGate: boolean;
  semanticWait: boolean;
  topicSwitch: boolean;
  taskIntent: boolean;
}

export interface TopicCompressionCandidate {
  messageCount: number;
  estimatedReclaimableTokens: number;
}

export function resolveTurnPlannerRequirements(config: AppConfig, input: {
  canSkipReply: boolean;
  pendingWaitPasses: number;
  availableToolsetCount: number;
  taskContext?: TurnPlannerTaskContext | null | undefined;
  topicCompressionCandidate?: TopicCompressionCandidate | null | undefined;
}): TurnPlannerRequirements {
  const options = config.llm.turnPlanner;
  const candidate = input.topicCompressionCandidate;
  return {
    modelSelection: getModelRefsForRole(config, "main_large").length > 0 && !areMainModelRoutesEquivalent(config),
    toolSelection: options.toolSelection === "planned" && input.availableToolsetCount > 0,
    replyGate: input.canSkipReply,
    semanticWait: options.semanticWait && input.pendingWaitPasses < options.maxWaitPasses,
    topicSwitch: config.conversation.historyCompression.enabled && config.llm.summarizer.enabled
      && candidate != null && candidate.messageCount >= options.topicCompressionMinMessages
      && candidate.estimatedReclaimableTokens >= options.topicCompressionMinTokens,
    taskIntent: input.taskContext?.primary != null || (input.taskContext?.parked.length ?? 0) > 0
  };
}

export function getTurnPlannerReasons(requirements: TurnPlannerRequirements): string[] {
  return Object.entries(requirements).filter(([, needed]) => needed).map(([reason]) => reason);
}

// Output limits may include hidden reasoning. Only cap routes whose every candidate
// is non-thinking or whose provider actually disables thinking for this request.
export function resolveTurnPlannerOutputTokenLimit(config: AppConfig, modelRefs: readonly string[]): number | undefined {
  if (config.llm.turnPlanner.enableThinking || modelRefs.length === 0) return undefined;
  const canUseShortBudget = modelRefs.every((ref) => {
    const model = config.llm.models[ref];
    const provider = model && config.llm.providers[model.provider];
    if (!model || !provider) return false;
    if (!model.supportsThinking) return true;
    if (!model.thinkingControllable) return false;
    switch (provider.type) {
      case "anthropic":
      case "deepseek":
      case "lmstudio":
      case "openai_responses":
        return true;
      case "openai":
      case "dashscope":
        return provider.features.thinking?.type === "flag";
      case "google":
      case "vertex":
      case "vertex_express":
        // includeThoughts only controls returned summaries, not reasoning itself.
        return false;
    }
  });
  return canUseShortBudget ? 512 : undefined;
}

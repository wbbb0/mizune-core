import type { TurnPlannerContextDependency, TurnPlannerFollowupMode, TurnPlannerRequiredCapability, TurnPlannerResult } from "#conversation/turnPlanner.ts";
import type { GenerationRuntimeBatchMessage } from "./generationExecutor.ts";
import type { GenerationPromptToolEvent } from "./generationPromptBuilder.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { hasDiceRollSignal } from "#llm/tools/runtime/diceExpression.ts";

type RecentToolsetDomains = {
  hasWeb: boolean;
  hasShell: boolean;
  hasLocalFiles: boolean;
  hasChatContext: boolean;
};

export interface ToolsetSupplementSignals {
  hasStructuredResolvableContent: boolean;
  requiredCapabilities: TurnPlannerRequiredCapability[];
  contextDependencies: TurnPlannerContextDependency[];
  recentDomainReuse: string[];
  followupMode: TurnPlannerFollowupMode;
  recentDomains: RecentToolsetDomains;
  hasDiceRollSignal: boolean;
}

export function buildToolsetSupplementSignals(input: {
  availableToolsets: ToolsetView[];
  batchMessages: GenerationRuntimeBatchMessage[];
  recentToolEvents: GenerationPromptToolEvent[];
  plannerDecision?: TurnPlannerResult | null;
}): ToolsetSupplementSignals {
  return {
    hasStructuredResolvableContent: hasStructuredResolvableContent(input.batchMessages),
    requiredCapabilities: input.plannerDecision?.requiredCapabilities ?? [],
    contextDependencies: input.plannerDecision?.contextDependencies ?? [],
    recentDomainReuse: input.plannerDecision?.recentDomainReuse ?? [],
    followupMode: input.plannerDecision?.followupMode ?? "none",
    recentDomains: summarizeRecentDomains(input.availableToolsets, input.recentToolEvents),
    hasDiceRollSignal: input.batchMessages.some((message) => hasDiceRollSignal(message.text))
  };
}

function summarizeRecentDomains(
  availableToolsets: ToolsetView[],
  recentToolEvents: GenerationPromptToolEvent[]
): RecentToolsetDomains {
  const toolToToolsets = new Map<string, Set<string>>();
  for (const toolset of availableToolsets) {
    for (const toolName of toolset.toolNames) {
      const existing = toolToToolsets.get(toolName) ?? new Set<string>();
      existing.add(toolset.id);
      toolToToolsets.set(toolName, existing);
    }
  }

  let hasWeb = false;
  let hasShell = false;
  let hasLocalFiles = false;
  let hasChatContext = false;
  for (const event of recentToolEvents.slice(-6)) {
    const mapped = toolToToolsets.get(event.toolName);
    if (mapped?.has("web_research")) {
      hasWeb = true;
    }
    if (mapped?.has("shell_runtime")) {
      hasShell = true;
    }
    if (mapped?.has("local_file_io")) {
      hasLocalFiles = true;
    }
    if (mapped?.has("chat_context")) {
      hasChatContext = true;
    }
  }

  return { hasWeb, hasShell, hasLocalFiles, hasChatContext };
}

function hasStructuredResolvableContent(messages: GenerationRuntimeBatchMessage[]): boolean {
  return messages.some((message) => (
    Boolean(message.replyMessageId)
    || (message.forwardIds?.length ?? 0) > 0
    || (message.imageIds?.length ?? 0) > 0
    || (message.emojiIds?.length ?? 0) > 0
    || (message.attachments?.length ?? 0) > 0
  ));
}

import type { TurnPlannerContextDependency, TurnPlannerFollowupMode, TurnPlannerRequiredCapability, TurnPlannerResult } from "#conversation/turnPlanner.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";

type RecentToolsetDomains = {
  hasWeb: boolean;
  hasShell: boolean;
  hasLocalFiles: boolean;
  hasChatContext: boolean;
};

export interface ToolsetSupplementSignals {
  requiredCapabilities: TurnPlannerRequiredCapability[];
  contextDependencies: TurnPlannerContextDependency[];
  recentDomainReuse: string[];
  followupMode: TurnPlannerFollowupMode;
  recentDomains: RecentToolsetDomains;
}

export function buildToolsetSupplementSignals(input: {
  availableToolsets: ToolsetView[];
  recentTranscriptItems: InternalTranscriptItem[];
  plannerDecision?: TurnPlannerResult | null;
}): ToolsetSupplementSignals {
  return {
    requiredCapabilities: input.plannerDecision?.requiredCapabilities ?? [],
    contextDependencies: input.plannerDecision?.contextDependencies ?? [],
    recentDomainReuse: input.plannerDecision?.recentDomainReuse ?? [],
    followupMode: input.plannerDecision?.followupMode ?? "none",
    recentDomains: summarizeRecentDomains(input.availableToolsets, input.recentTranscriptItems)
  };
}

function summarizeRecentDomains(
  availableToolsets: ToolsetView[],
  recentTranscriptItems: InternalTranscriptItem[]
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
  const recentToolNames = recentTranscriptItems
    .flatMap((item) => {
      if (item.kind === "tool_result") {
        return [item.toolName];
      }
      if (item.kind === "assistant_tool_call") {
        return item.toolCalls.map((toolCall) => toolCall.function.name);
      }
      return [];
    })
    .slice(-6);

  for (const toolName of recentToolNames) {
    const mapped = toolToToolsets.get(toolName);
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

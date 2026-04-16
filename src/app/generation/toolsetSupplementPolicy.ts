import type { ToolsetSupplementSignals } from "./toolsetSupplementSignals.ts";

export interface ToolsetSupplementDecision {
  toolsetId: string;
  reason: string;
}

const TOOLSET_SIGNAL_RULES: Array<{
  toolsetId: string;
  reason: string;
  signal: keyof ToolsetSupplementSignals;
}> = [
  {
    toolsetId: "web_research",
    reason: "current_web_intent",
    signal: "hasWebIntent"
  },
  {
    toolsetId: "shell_runtime",
    reason: "current_shell_intent",
    signal: "hasShellIntent"
  },
  {
    toolsetId: "local_file_io",
    reason: "current_local_file_intent",
    signal: "hasLocalFileIntent"
  },
  {
    toolsetId: "memory_profile",
    reason: "current_memory_intent",
    signal: "hasMemoryIntent"
  },
  {
    toolsetId: "scheduler_admin",
    reason: "current_scheduler_intent",
    signal: "hasSchedulerIntent"
  },
  {
    toolsetId: "time_utils",
    reason: "current_time_intent",
    signal: "hasTimeIntent"
  },
  {
    toolsetId: "social_admin",
    reason: "current_social_intent",
    signal: "hasSocialIntent"
  },
  {
    toolsetId: "conversation_navigation",
    reason: "current_navigation_intent",
    signal: "hasConversationNavigationIntent"
  },
  {
    toolsetId: "chat_delegation",
    reason: "current_delegation_intent",
    signal: "hasDelegationIntent"
  },
  {
    toolsetId: "comfy_image",
    reason: "current_comfy_intent",
    signal: "hasComfyIntent"
  }
] as const;

// Encodes supplement policy in one place so the planner can explain why a toolset
// was auto-added without inlining branchy linkage logic in execution code.
export function decideToolsetSupplements(input: {
  selectedToolsetIds: string[];
  availableToolsetIds: string[];
  signals: ToolsetSupplementSignals;
}): ToolsetSupplementDecision[] {
  const availableToolsets = new Set(input.availableToolsetIds);
  const selected = new Set(input.selectedToolsetIds.filter((item) => availableToolsets.has(item)));
  const decisions: ToolsetSupplementDecision[] = [];

  const add = (toolsetId: string, reason: string) => {
    if (!availableToolsets.has(toolsetId) || selected.has(toolsetId)) {
      return;
    }
    selected.add(toolsetId);
    decisions.push({ toolsetId, reason });
  };

  if (input.signals.hasStructuredResolvableContent) {
    add("chat_context", "structured_content");
  }
  for (const rule of TOOLSET_SIGNAL_RULES) {
    if (input.signals[rule.signal] === true) {
      add(rule.toolsetId, rule.reason);
    }
  }

  if (selected.has("web_research") && input.signals.hasDownloadIntent) {
    add("local_file_io", "web_download_linkage");
  }
  if (selected.has("local_file_io") && input.signals.hasWebContextReference) {
    add("web_research", "workspace_web_linkage");
  }
  if (selected.has("chat_context") && input.signals.hasWebIntent) {
    add("web_research", "chat_context_web_linkage");
  }

  if (input.signals.isEllipticalFollowup) {
    if (input.signals.recentDomains.hasWeb) {
      add("web_research", "followup_recent_web");
    }
    if (input.signals.recentDomains.hasShell) {
      add("shell_runtime", "followup_recent_shell");
    }
    if (input.signals.recentDomains.hasLocalFiles) {
      add("local_file_io", "followup_recent_workspace");
    }
    if (input.signals.recentDomains.hasChatContext || input.signals.hasFollowupReference) {
      add("chat_context", "followup_recent_context");
    }
    if (input.signals.hasDownloadIntent && (input.signals.recentDomains.hasWeb || selected.has("web_research"))) {
      add("local_file_io", "followup_recent_web_download");
    }
  }

  return decisions;
}

import type { ToolsetSupplementSignals } from "./toolsetSupplementSignals.ts";

export interface ToolsetSupplementDecision {
  toolsetId: string;
  reason: string;
}

const CAPABILITY_TOOLSET_RULES: Array<{
  capability: ToolsetSupplementSignals["requiredCapabilities"][number];
  toolsetId: string;
  reason: string;
}> = [
  { capability: "external_info_lookup", toolsetId: "web_research", reason: "planner_external_info_lookup" },
  { capability: "web_navigation", toolsetId: "web_research", reason: "planner_web_navigation" },
  { capability: "local_file_access", toolsetId: "local_file_io", reason: "planner_local_file_access" },
  { capability: "shell_execution", toolsetId: "shell_runtime", reason: "planner_shell_execution" },
  { capability: "memory_write", toolsetId: "memory_profile", reason: "planner_memory_write" },
  { capability: "scheduler_management", toolsetId: "scheduler_admin", reason: "planner_scheduler_management" },
  { capability: "time_lookup", toolsetId: "time_utils", reason: "planner_time_lookup" },
  { capability: "social_admin", toolsetId: "social_admin", reason: "planner_social_admin" },
  { capability: "conversation_navigation", toolsetId: "conversation_navigation", reason: "planner_conversation_navigation" },
  { capability: "chat_delegation", toolsetId: "chat_delegation", reason: "planner_chat_delegation" },
  { capability: "image_generation", toolsetId: "comfy_image", reason: "planner_image_generation" }
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
  for (const rule of CAPABILITY_TOOLSET_RULES) {
    if (input.signals.requiredCapabilities.includes(rule.capability)) {
      add(rule.toolsetId, rule.reason);
    }
  }

  if (selected.has("local_file_io") && input.signals.contextDependencies.includes("prior_web_context")) {
    add("web_research", "planner_prior_web_context");
  }
  if (selected.has("web_research") && input.signals.contextDependencies.includes("prior_file_context")) {
    add("local_file_io", "planner_prior_file_context");
  }
  if (selected.has("chat_context") && input.signals.contextDependencies.includes("prior_web_context")) {
    add("web_research", "chat_context_prior_web_context");
  }

  const isFollowup = input.signals.followupMode === "elliptical" || input.signals.followupMode === "explicit_reference";
  if (isFollowup) {
    for (const toolsetId of input.signals.recentDomainReuse) {
      add(toolsetId, "planner_recent_domain_reuse");
    }
    if (input.signals.recentDomains.hasWeb) {
      add("web_research", "followup_recent_web");
    }
    if (input.signals.recentDomains.hasShell) {
      add("shell_runtime", "followup_recent_shell");
    }
    if (input.signals.recentDomains.hasLocalFiles) {
      add("local_file_io", "followup_recent_workspace");
    }
    if (input.signals.recentDomains.hasChatContext || input.signals.contextDependencies.includes("prior_chat_context")) {
      add("chat_context", "followup_recent_context");
    }
  }

  return decisions;
}

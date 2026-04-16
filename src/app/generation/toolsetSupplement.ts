import type { GenerationRuntimeBatchMessage } from "./generationExecutor.ts";
import type { GenerationPromptToolEvent } from "./generationPromptBuilder.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { buildToolsetSupplementSignals } from "./toolsetSupplementSignals.ts";

export interface ToolsetSupplementInput {
  selectedToolsetIds: string[];
  availableToolsets: ToolsetView[];
  batchMessages: GenerationRuntimeBatchMessage[];
  recentToolEvents: GenerationPromptToolEvent[];
}

export interface ToolsetSupplementResult {
  toolsetIds: string[];
  addedToolsetIds: string[];
  reasons: string[];
}

const TOOLSET_SIGNAL_RULES: Array<{
  toolsetId: string;
  reason: string;
  signal: keyof ReturnType<typeof buildToolsetSupplementSignals>;
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

export function supplementPlannedToolsets(input: ToolsetSupplementInput): ToolsetSupplementResult {
  const availableToolsets = new Set(input.availableToolsets.map((item) => item.id));
  const selected = new Set(input.selectedToolsetIds.filter((item) => availableToolsets.has(item)));
  const reasons: string[] = [];
  const signals = buildToolsetSupplementSignals({
    availableToolsets: input.availableToolsets,
    batchMessages: input.batchMessages,
    recentToolEvents: input.recentToolEvents
  });

  const add = (toolsetId: string, reason: string) => {
    if (!availableToolsets.has(toolsetId) || selected.has(toolsetId)) {
      return;
    }
    selected.add(toolsetId);
    reasons.push(`${toolsetId}:${reason}`);
  };

  if (signals.hasStructuredResolvableContent) {
    add("chat_context", "structured_content");
  }
  for (const rule of TOOLSET_SIGNAL_RULES) {
    if (signals[rule.signal] === true) {
      add(rule.toolsetId, rule.reason);
    }
  }

  if (selected.has("web_research") && signals.hasDownloadIntent) {
    add("local_file_io", "web_download_linkage");
  }
  if (selected.has("local_file_io") && signals.hasWebContextReference) {
    add("web_research", "workspace_web_linkage");
  }
  if (selected.has("chat_context") && signals.hasWebIntent) {
    add("web_research", "chat_context_web_linkage");
  }

  if (signals.isEllipticalFollowup) {
    if (signals.recentDomains.hasWeb) {
      add("web_research", "followup_recent_web");
    }
    if (signals.recentDomains.hasShell) {
      add("shell_runtime", "followup_recent_shell");
    }
    if (signals.recentDomains.hasLocalFiles) {
      add("local_file_io", "followup_recent_workspace");
    }
    if (signals.recentDomains.hasChatContext || signals.hasFollowupReference) {
      add("chat_context", "followup_recent_context");
    }
    if (signals.hasDownloadIntent && (signals.recentDomains.hasWeb || selected.has("web_research"))) {
      add("local_file_io", "followup_recent_web_download");
    }
  }

  const ordered = input.availableToolsets
    .map((item) => item.id)
    .filter((item) => selected.has(item));
  const addedToolsetIds = ordered.filter((item) => !input.selectedToolsetIds.includes(item));
  return {
    toolsetIds: ordered,
    addedToolsetIds,
    reasons
  };
}

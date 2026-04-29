import type { TurnPlannerResult } from "#conversation/turnPlanner.ts";
import { collectReferencedImageIds } from "#images/imagePromptContext.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import {
  dedupeResolvedChatAttachments,
  isPendingChatAttachmentId
} from "#services/workspace/chatAttachments.ts";
import type { GenerationRuntimeBatchMessage } from "./generationExecutor.ts";

export interface TurnToolsetActivationContext {
  availableToolsets: ToolsetView[];
  batchMessages: GenerationRuntimeBatchMessage[];
  recentMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>;
  modeId: string;
  plannerDecision?: TurnPlannerResult | null;
}

export interface AutoActivatedToolsets {
  toolsetIds: string[];
  addedToolsetIds: string[];
  reasons: string[];
}

export function resolveAutoActivatedToolsets(input: TurnToolsetActivationContext & {
  selectedToolsetIds?: string[];
}): AutoActivatedToolsets {
  const availableIds = new Set(input.availableToolsets.map((item) => item.id));
  const selected = new Set((input.selectedToolsetIds ?? []).filter((id) => availableIds.has(id)));
  const initiallySelected = new Set(selected);
  const reasons: string[] = [];

  const add = (toolsetId: string, reason: string): void => {
    if (!availableIds.has(toolsetId) || selected.has(toolsetId)) {
      return;
    }
    selected.add(toolsetId);
    reasons.push(`${toolsetId}:${reason}`);
  };

  if (hasCurrentStructuredChatContent(input.batchMessages)) {
    add("chat_context", "current_structured_chat_content");
  } else if (
    hasRecentStructuredChatContent(input.recentMessages)
    && plannerIndicatesPriorChatContext(input.plannerDecision ?? null)
  ) {
    add("chat_context", "recent_structured_chat_content");
  }

  if (input.modeId === "scenario_host") {
    add("scenario_host_state", "scenario_host_mode");
  }

  const toolsetIds = input.availableToolsets
    .map((item) => item.id)
    .filter((id) => selected.has(id));
  return {
    toolsetIds,
    addedToolsetIds: toolsetIds.filter((id) => !initiallySelected.has(id)),
    reasons
  };
}

function hasCurrentStructuredChatContent(messages: GenerationRuntimeBatchMessage[]): boolean {
  return messages.some((message) => (
    Boolean(message.replyMessageId)
    || (message.forwardIds?.length ?? 0) > 0
    || (message.imageIds?.some((fileId) => !isPendingChatAttachmentId(fileId)) ?? false)
    || (message.emojiIds?.some((fileId) => !isPendingChatAttachmentId(fileId)) ?? false)
    || (message.specialSegments?.length ?? 0) > 0
    || dedupeResolvedChatAttachments(message.attachments ?? []).length > 0
  ));
}

function hasRecentStructuredChatContent(
  messages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>
): boolean {
  return collectReferencedImageIds(messages).length > 0
    || messages.some((message) => /⟦ref\s+kind="(?:reply|forward|emoji|special)"/u.test(message.content));
}

function plannerIndicatesPriorChatContext(plannerDecision: TurnPlannerResult | null): boolean {
  if (!plannerDecision) {
    return false;
  }
  return plannerDecision.contextDependencies.includes("structured_message_context")
    || plannerDecision.contextDependencies.includes("prior_chat_context")
    || plannerDecision.followupMode === "elliptical"
    || plannerDecision.followupMode === "explicit_reference";
}

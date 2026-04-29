import type { TurnPlannerResult } from "#conversation/turnPlanner.ts";
import type { GenerationPromptToolEvent } from "./generationPromptBuilder.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { decideToolsetSupplements } from "./toolsetSupplementPolicy.ts";
import { buildToolsetSupplementSignals } from "./toolsetSupplementSignals.ts";

export interface ToolsetSupplementInput {
  selectedToolsetIds: string[];
  availableToolsets: ToolsetView[];
  recentToolEvents: GenerationPromptToolEvent[];
  plannerDecision?: TurnPlannerResult | null;
}

export interface ToolsetSupplementResult {
  toolsetIds: string[];
  addedToolsetIds: string[];
  reasons: string[];
}

export function supplementPlannedToolsets(input: ToolsetSupplementInput): ToolsetSupplementResult {
  const availableToolsets = new Set(input.availableToolsets.map((item) => item.id));
  const selected = new Set(input.selectedToolsetIds.filter((item) => availableToolsets.has(item)));
  const signals = buildToolsetSupplementSignals({
    availableToolsets: input.availableToolsets,
    recentToolEvents: input.recentToolEvents,
    plannerDecision: input.plannerDecision ?? null
  });
  const reasons: string[] = [];

  for (const decision of decideToolsetSupplements({
    selectedToolsetIds: Array.from(selected),
    availableToolsetIds: input.availableToolsets.map((item) => item.id),
    signals
  })) {
    if (!selected.has(decision.toolsetId)) {
      selected.add(decision.toolsetId);
      reasons.push(`${decision.toolsetId}:${decision.reason}`);
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

import type { MemoryCategory, ScopeConflictWarning } from "./memoryCategory.ts";

export type MemoryWriteAction = "created" | "updated_existing";
export type MemoryWriteFinalAction = MemoryWriteAction | "warning_scope_conflict";
export type MemoryDedupMatchKind = "none" | "explicit_id" | "near_duplicate";
export type MemoryRerouteResult = "not_applicable" | "not_rerouted_scope_warning";

export interface MemoryDedupDetails {
  matchedExistingId: string | null;
  matchedBy: MemoryDedupMatchKind;
  similarityScore: number | null;
}

export interface MemoryRerouteDetails {
  result: MemoryRerouteResult;
  suggestedScope: MemoryCategory | null;
  reason: string | null;
}

export interface MemoryWriteDiagnostics {
  targetCategory: MemoryCategory;
  action: MemoryWriteAction;
  finalAction: MemoryWriteFinalAction;
  dedup: MemoryDedupDetails;
  reroute: MemoryRerouteDetails;
  warning: ScopeConflictWarning | null;
}

export function buildMemoryDedupDetails(input: {
  explicitId?: string | null;
  duplicateId?: string | null;
  similarityScore?: number | null;
  matchedExisting: boolean;
}): MemoryDedupDetails {
  if (input.explicitId && input.matchedExisting) {
    return {
      matchedExistingId: input.explicitId,
      matchedBy: "explicit_id",
      similarityScore: null
    };
  }
  if (input.duplicateId) {
    return {
      matchedExistingId: input.duplicateId,
      matchedBy: "near_duplicate",
      similarityScore: input.similarityScore ?? null
    };
  }
  return {
    matchedExistingId: null,
    matchedBy: "none",
    similarityScore: null
  };
}

export function resolveMemoryWriteFinalAction(
  action: MemoryWriteAction,
  warning: ScopeConflictWarning | null
): MemoryWriteFinalAction {
  return warning ? "warning_scope_conflict" : action;
}

export function buildMemoryRerouteDetails(
  warning: ScopeConflictWarning | null
): MemoryRerouteDetails {
  return warning
    ? {
        result: "not_rerouted_scope_warning",
        suggestedScope: warning.suggestedScope,
        reason: warning.reason
      }
    : {
        result: "not_applicable",
        suggestedScope: null,
        reason: null
      };
}

export function buildMemoryWriteDiagnostics(input: {
  targetCategory: MemoryCategory;
  action: MemoryWriteAction;
  dedup: MemoryDedupDetails;
  warning: ScopeConflictWarning | null;
}): MemoryWriteDiagnostics {
  return {
    targetCategory: input.targetCategory,
    action: input.action,
    finalAction: resolveMemoryWriteFinalAction(input.action, input.warning),
    dedup: input.dedup,
    reroute: buildMemoryRerouteDetails(input.warning),
    warning: input.warning
  };
}

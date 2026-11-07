import type { TranscriptItem } from "../../api/types.ts";

type PlannerDecision = Extract<TranscriptItem, { kind: "gate_decision" }>;
type ModelRouteEvent = Extract<TranscriptItem, { kind: "model_route_event" }>;

export function describePlannerModelSelection(item: PlannerDecision): string | null {
  if (item.modelSelectionStatus === "undetermined") return "未判定";
  if (item.modelSelectionStatus === "not_requested") return "本轮未请求选模";
  if (item.modelTier === "large") return "大模型";
  if (item.modelTier === "small") return "小模型";
  return null;
}

export function describeModelRouteType(type: ModelRouteEvent["routeType"]): string {
  switch (type) {
    case "self_upgrade": return "自助升级";
    case "policy_upgrade": return "策略升级";
    case "policy_unavailable": return "无法升级";
  }
}

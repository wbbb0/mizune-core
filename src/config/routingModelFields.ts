import type { LlmRoutingPresetFile } from "./configModel.ts";

/** 持久化路由字段目录；配置归一化和目录变更共用，避免新增角色被静默丢弃。 */
export const ROUTING_MODEL_FIELDS = [
  "mainSmall",
  "mainLarge",
  "summarizer",
  "textInspector",
  "sessionCaptioner",
  "imageCaptioner",
  "imageInspector",
  "audioTranscription",
  "imageGenerator",
  "speechGenerator",
  "decision",
  "turnPlanner"
] as const satisfies ReadonlyArray<Exclude<keyof LlmRoutingPresetFile, "historyWindow" | "tokenLimits">>;

export type RoutingModelField = typeof ROUTING_MODEL_FIELDS[number];

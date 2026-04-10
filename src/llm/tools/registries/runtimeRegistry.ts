import type { AppConfig } from "#config/config.ts";
import { debugToolDescriptors, debugToolHandlers } from "../runtime/debugTools.ts";
import { getComfyToolDescriptors, comfyToolHandlers } from "../runtime/comfyTools.ts";
import { resourceToolDescriptors, resourceToolHandlers } from "../runtime/resourceTools.ts";
import { schedulerToolDescriptors, schedulerToolHandlers } from "../runtime/schedulerTools.ts";
import { shellToolDescriptors, shellToolHandlers } from "../runtime/shellTools.ts";
import { timeToolDescriptors, timeToolHandlers } from "../runtime/timeTools.ts";
import { turnPlannerToolDescriptors, turnPlannerToolHandlers } from "../runtime/turnPlannerTools.ts";
import {
  chatFileToolDescriptors,
  chatFileToolHandlers,
  localFileToolDescriptors,
  localFileToolHandlers
} from "../runtime/workspaceTools.ts";

const runtimeStaticToolDescriptorsRegistry = [
  ...debugToolDescriptors,
  ...resourceToolDescriptors,
  ...turnPlannerToolDescriptors,
  ...schedulerToolDescriptors,
  ...shellToolDescriptors,
  ...localFileToolDescriptors,
  ...chatFileToolDescriptors,
  ...timeToolDescriptors
];

export function runtimeToolDescriptorsRegistry(config?: AppConfig) {
  return [
    ...runtimeStaticToolDescriptorsRegistry,
    ...(config ? getComfyToolDescriptors(config) : [])
  ];
}

export const runtimeToolHandlersRegistry = {
  ...comfyToolHandlers,
  ...debugToolHandlers,
  ...resourceToolHandlers,
  ...turnPlannerToolHandlers,
  ...schedulerToolHandlers,
  ...shellToolHandlers,
  ...localFileToolHandlers,
  ...chatFileToolHandlers,
  ...timeToolHandlers
};

import type { AppConfig } from "#config/config.ts";
import { debugToolDescriptors, debugToolHandlers } from "../runtime/debugTools.ts";
import { getComfyToolDescriptors, comfyToolHandlers } from "../runtime/comfyTools.ts";
import { resourceToolDescriptors, resourceToolHandlers } from "../runtime/resourceTools.ts";
import { schedulerToolDescriptors, schedulerToolHandlers } from "../runtime/schedulerTools.ts";
import { shellToolDescriptors, shellToolHandlers } from "../runtime/shellTools.ts";
import { timeToolDescriptors, timeToolHandlers } from "../runtime/timeTools.ts";
import { workspaceToolDescriptors, workspaceToolHandlers } from "../runtime/workspaceTools.ts";

const runtimeStaticToolDescriptorsRegistry = [
  ...debugToolDescriptors,
  ...resourceToolDescriptors,
  ...schedulerToolDescriptors,
  ...shellToolDescriptors,
  ...workspaceToolDescriptors,
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
  ...schedulerToolHandlers,
  ...shellToolHandlers,
  ...workspaceToolHandlers,
  ...timeToolHandlers
};

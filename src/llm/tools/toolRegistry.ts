import { skillToolDescriptors, skillToolHandlers } from './runtime/skillTools.ts';
import type { AppConfig } from "#config/config.ts";
import type { ToolHandler } from "./core/shared.ts";
import { conversationToolDescriptors, conversationToolHandlers } from "./registries/conversationRegistry.ts";
import { profileToolDescriptorsRegistry, profileToolHandlersRegistry } from "./registries/profileRegistry.ts";
import { runtimeToolDescriptorsRegistry, runtimeToolHandlersRegistry } from "./registries/runtimeRegistry.ts";
import { webToolDescriptorsRegistry, webToolHandlersRegistry } from "./registries/webRegistry.ts";

export function getBuiltinToolDescriptors(config?: AppConfig) {
  return [
    ...skillToolDescriptors,
    ...runtimeToolDescriptorsRegistry(config),
    ...conversationToolDescriptors,
    ...profileToolDescriptorsRegistry,
    ...webToolDescriptorsRegistry,
  ];
}

export function getBuiltinToolDescriptorByName(name: string, config?: AppConfig) {
  return getBuiltinToolDescriptors(config)
    .find((tool) => tool.definition.function.name === name);
}

export const builtinToolHandlers: Record<string, ToolHandler> = {
  ...skillToolHandlers,
  ...runtimeToolHandlersRegistry,
  ...conversationToolHandlers,
  ...profileToolHandlersRegistry,
  ...webToolHandlersRegistry,
};

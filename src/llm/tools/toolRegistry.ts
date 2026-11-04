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

const rawBuiltinToolHandlers: Record<string, ToolHandler> = {
  ...skillToolHandlers,
  ...runtimeToolHandlersRegistry,
  ...conversationToolHandlers,
  ...profileToolHandlersRegistry,
  ...webToolHandlersRegistry,
};

// Enforce connector capabilities again at execution, including non-model callers.
export const builtinToolHandlers: Record<string, ToolHandler> = Object.fromEntries(
  Object.entries(rawBuiltinToolHandlers).map(([name, handler]) => [name, async (call: Parameters<ToolHandler>[0], args: unknown, context: Parameters<ToolHandler>[2]) => {
    const descriptor = getBuiltinToolDescriptorByName(name, context.config);
    if (descriptor?.requiresOneBot && context.replyDelivery === "qq_official") {
      return JSON.stringify({ error: "当前官方连接不支持此 OneBot 能力。" });
    }
    return handler(call, args, context);
  }])
);

import { resolveToolAvailability, unavailableToolParameters } from "./core/toolAvailability.ts";
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

// Raw handlers remain private; all production execution crosses the shared checks.
export const executeBuiltinToolHandler: ToolHandler = async (call, args, context) => {
  const descriptor = getBuiltinToolDescriptorByName(call.function.name, context.config);
  const availabilityContext = { ...(context.executionModelRef ? { modelRef: context.executionModelRef } : {}), config: context.config, relationship: context.relationship, currentUser: context.currentUser,
    modeId: context.sessionManager.getSession(context.lastMessage.sessionId)?.modeId,
    operationMode: context.sessionManager.getOperationMode(context.lastMessage.sessionId),
    setupMode: context.executionSetupMode,
    visibilityContext: { sessionId: context.lastMessage.sessionId, replyDelivery: context.replyDelivery, modelSelfUpgradeAvailable: context.modelRoutingAccess !== undefined } };
  if (!descriptor) return JSON.stringify({ error: "不支持的工具。" });
  const availability = resolveToolAvailability(descriptor, availabilityContext);
  if (!availability.available) return JSON.stringify({ error: availability.reason });
  const hidden = unavailableToolParameters(descriptor, availabilityContext);
  if (args && typeof args === "object" && hidden.some(name => Object.prototype.hasOwnProperty.call(args, name))) return JSON.stringify({ error: "当前会话不允许使用此工具参数。" });
  const handler = rawBuiltinToolHandlers[call.function.name];
  return handler ? handler(call, args, context) : JSON.stringify({ error: "不支持的工具。" });
};

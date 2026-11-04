import type { AppConfig } from "#config/config.ts";
import type { BuiltinToolContext, Relationship, ToolDescriptor, ToolVisibilityContext } from "./shared.ts";
import { resolveConnectorCapabilities } from "#services/messaging/connectorCapabilities.ts";
import type { LlmToolDefinition } from "../../llmClient.ts";

export interface ToolAvailabilityContext {
  config?: AppConfig | undefined;
  relationship: Relationship;
  currentUser: BuiltinToolContext["currentUser"];
  visibilityContext?: ToolVisibilityContext | undefined;
  modelRef?: string | string[];
}
export type ToolUnavailableReason = "permission_denied" | "service_disabled" | "unsupported_capability" | "wrong_session_scope";
export function resolveToolAvailability(tool: ToolDescriptor, context: ToolAvailabilityContext): { available: boolean; reason: string | null; reasonCode: ToolUnavailableReason | null } {
  const denied = (reasonCode: ToolUnavailableReason, reason: string) => ({ available: false, reason, reasonCode });
  const access = tool.accessLevel ?? (tool.ownerOnly ? "owner" : "any");
  if (access === "owner" && context.relationship !== "owner" || access === "operator" && context.relationship !== "owner" && context.currentUser?.specialRole !== "npc") return denied("permission_denied", "当前用户没有使用权限");
  if (context.config && tool.isEnabled && !tool.isEnabled(context.config, context.modelRef ? { modelRef: context.modelRef } : {})) return denied("service_disabled", "功能配置未启用");
  if (tool.capabilities) {
    const available = context.config ? resolveConnectorCapabilities(context.config, context.visibilityContext ?? {}) : new Set();
    if (tool.capabilities.all?.some(capability => !available.has(capability)) || tool.capabilities.any && !tool.capabilities.any.some(capability => available.has(capability))) return denied("unsupported_capability", "当前会话连接不支持所需能力");
  }
  if (tool.isVisible && !tool.isVisible(context.visibilityContext ?? {})) return denied("wrong_session_scope", "当前会话不适用此工具");
  return { available: true, reason: null, reasonCode: null };
}
export function unavailableToolParameters(tool: ToolDescriptor, context: Pick<ToolAvailabilityContext, "config" | "visibilityContext">): string[] {
  const capabilities = context.config ? resolveConnectorCapabilities(context.config, context.visibilityContext ?? {}) : new Set();
  return Object.entries(tool.parameterCapabilities ?? {}).filter(([, capability]) => !capabilities.has(capability)).map(([name]) => name);
}
export function projectToolDefinition(tool: ToolDescriptor, context: Pick<ToolAvailabilityContext, "config" | "visibilityContext">): LlmToolDefinition {
  const hidden = unavailableToolParameters(tool, context);
  if (!hidden.length) return tool.definition;
  const definition = structuredClone(tool.definition);
  const schema = definition.function.parameters as { properties?: Record<string, unknown>; required?: string[] };
  for (const name of hidden) delete schema.properties?.[name];
  if (schema.required) schema.required = schema.required.filter(name => !hidden.includes(name));
  if (tool.descriptionWithoutParameters) definition.function.description = tool.descriptionWithoutParameters;
  return definition;
}

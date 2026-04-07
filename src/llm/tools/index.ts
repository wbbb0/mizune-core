import type { LlmToolCall, LlmToolDefinition, LlmToolExecutionResult } from "../llmClient.ts";
import type { BuiltinToolContext, Relationship, ToolDescriptor, ToolHandler } from "./core/shared.ts";
import type { AppConfig } from "#config/config.ts";
import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { hasNativeSearchFeature } from "../provider/providerFeatures.ts";
import { builtinToolHandlers, getBuiltinToolDescriptors } from "./toolRegistry.ts";

function hasToolAccess(
  tool: ToolDescriptor,
  relationship: Relationship,
  currentUser: BuiltinToolContext["currentUser"]
): boolean {
  const accessLevel = tool.accessLevel ?? (tool.ownerOnly ? "owner" : "any");
  if (accessLevel === "any") {
    return true;
  }
  if (accessLevel === "owner") {
    return relationship === "owner";
  }
  return relationship === "owner" || currentUser?.specialRole === "npc";
}

interface BuiltinToolSelectionOptions {
  relationship: Relationship;
  currentUser: BuiltinToolContext["currentUser"];
  config?: AppConfig;
  modelRef?: string | string[];
  availableToolNames?: string[];
  includeDebugTools?: boolean;
}

function shouldHideExternalSearchTool(config: AppConfig | undefined, modelRef: string | string[] | undefined): boolean {
  if (!config || !modelRef) {
    return false;
  }
  return hasNativeSearchFeature(config, modelRef);
}

function selectBuiltinToolDescriptors(options: BuiltinToolSelectionOptions) {
  const allowedToolNames = options.availableToolNames
    ? new Set(options.availableToolNames)
    : null;
  const hideExternalSearchTool = shouldHideExternalSearchTool(options.config, options.modelRef);
  const modelSupportsTools = !options.config || !options.modelRef
    ? true
    : (getPrimaryModelProfile(options.config, options.modelRef)?.supportsTools ?? true);

  return modelSupportsTools
    ? getBuiltinToolDescriptors(options.config)
    .filter((tool) => tool.modelVisible !== false)
    .filter((tool) => !options.config || !tool.isEnabled || tool.isEnabled(options.config))
    .filter((tool) => hasToolAccess(tool, options.relationship, options.currentUser))
    .filter((tool) => options.includeDebugTools === true || tool.debugOnly !== true)
    .filter((tool) => !hideExternalSearchTool || !["ground_with_google_search", "search_with_iqs_lite_advanced"].includes(tool.definition.function.name))
    .filter((tool) => !allowedToolNames || allowedToolNames.has(tool.definition.function.name))
    .slice()
    .sort((left, right) => left.definition.function.name.localeCompare(right.definition.function.name))
    : [];
}

export function getBuiltinTools(
  relationship: Relationship,
  currentUserOrConfig?: BuiltinToolContext["currentUser"] | BuiltinToolContext["config"],
  config?: BuiltinToolContext["config"],
  options?: {
    modelRef?: string | string[];
    availableToolNames?: string[];
    includeDebugTools?: boolean;
  }
): LlmToolDefinition[] {
  const resolvedCurrentUser = config == null && currentUserOrConfig && "llm" in currentUserOrConfig
    ? null
    : (currentUserOrConfig as BuiltinToolContext["currentUser"] | undefined ?? null);
  const resolvedConfig = config ?? (
    currentUserOrConfig && "llm" in currentUserOrConfig
      ? currentUserOrConfig
      : undefined
  );
  return selectBuiltinToolDescriptors({
    relationship,
    currentUser: resolvedCurrentUser,
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(options?.modelRef ? { modelRef: options.modelRef } : {}),
    ...(options?.availableToolNames ? { availableToolNames: options.availableToolNames } : {}),
    ...(options?.includeDebugTools === true ? { includeDebugTools: true } : {})
  })
    .map((tool) => tool.definition);
}

export function getBuiltinToolNames(
  relationship: Relationship,
  currentUserOrConfig?: BuiltinToolContext["currentUser"] | BuiltinToolContext["config"],
  config?: BuiltinToolContext["config"],
  options?: {
    modelRef?: string | string[];
    availableToolNames?: string[];
    includeDebugTools?: boolean;
  }
): string[] {
  return getBuiltinTools(relationship, currentUserOrConfig, config, options)
    .map((tool) => tool.function.name);
}

export function createBuiltinToolExecutor(
  context: BuiltinToolContext,
  options?: {
    modelRef?: string | string[];
    availableToolNames?: string[];
    includeDebugTools?: boolean;
  }
): (toolCall: LlmToolCall, args: unknown) => Promise<string | LlmToolExecutionResult> {
  const allowedToolNames = new Set(
    selectBuiltinToolDescriptors({
      relationship: context.relationship,
      currentUser: context.currentUser,
      config: context.config,
      ...(options?.modelRef ? { modelRef: options.modelRef } : {}),
      ...(options?.availableToolNames ? { availableToolNames: options.availableToolNames } : {}),
      ...(options?.includeDebugTools === true ? { includeDebugTools: true } : {})
    })
      .map((tool) => tool.definition.function.name)
  );

  return async (toolCall, args) => {
    if (!allowedToolNames.has(toolCall.function.name)) {
      return JSON.stringify({
        error: `Tool is not available in the current model toolset: ${toolCall.function.name}`
      });
    }
    const handler = builtinToolHandlers[toolCall.function.name];
    if (!handler) {
      return JSON.stringify({
        error: `Unsupported contextual tool: ${toolCall.function.name}`
      });
    }
    return handler(toolCall, args, context);
  };
}

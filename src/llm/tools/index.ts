import { executeCharacterSetupTool } from "../../character/setupToolExecution.ts";
import { isCharacterSetupToolName } from "../../character/setupEditing.ts";
import { executeSetupAttempt } from "./setup/retryGuard.ts";
import { initializationToolDefinition, isScenarioSetupTool, isScenarioSetupToolName } from "./setup/initializationContracts.ts";
import { setupInputErrors, setupInputFailure } from "./setup/inputValidation.ts";
import type { LlmToolCall, LlmToolDefinition, LlmToolExecutionResult } from "../llmClient.ts";
import type {
  BuiltinToolContext,
  Relationship,
  ToolDescriptor,
  ToolHandler,
  ToolVisibilityContext
} from "./core/shared.ts";
import type { AppConfig } from "#config/config.ts";
import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { hasNativeSearchFeature } from "../provider/providerFeatures.ts";
import { builtinToolHandlers, getBuiltinToolDescriptors } from "./toolRegistry.ts";
import { projectRawToolContent } from "./core/toolResultProjection.ts";
import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";
import {
  filterProfileToolNamesForScope,
  resolveProfileToolScopeFromOperationMode,
  type ProfileToolScope
} from "./profileToolScope.ts";

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
  profileToolScope?: ProfileToolScope | null;
  visibilityContext?: ToolVisibilityContext;
}

function shouldHideExternalSearchTool(config: AppConfig | undefined, modelRef: string | string[] | undefined): boolean {
  if (!config || !modelRef) {
    return false;
  }
  return hasNativeSearchFeature(config, modelRef);
}

function selectBuiltinToolDescriptors(options: BuiltinToolSelectionOptions) {
  const descriptors = getBuiltinToolDescriptors(options.config);
  const profileScopedVisibleNames = options.profileToolScope
    ? new Set(filterProfileToolNamesForScope(
      descriptors.map((item) => item.definition.function.name),
      options.profileToolScope
    ))
    : null;
  const allowedToolNames = options.availableToolNames
    ? new Set(filterProfileToolNamesForScope(options.availableToolNames, options.profileToolScope))
    : null;
  const hideExternalSearchTool = shouldHideExternalSearchTool(options.config, options.modelRef);
  const modelSupportsTools = !options.config || !options.modelRef
    ? true
    : (getPrimaryModelProfile(options.config, options.modelRef)?.chat?.capabilities.supportsTools ?? true);

  return modelSupportsTools
    ? descriptors
    .filter((tool) => tool.modelVisible !== false)
    .filter((tool) => !options.config || !tool.isEnabled || tool.isEnabled(
      options.config,
      options.modelRef ? { modelRef: options.modelRef } : {}
    ))
    .filter((tool) => hasToolAccess(tool, options.relationship, options.currentUser))
    .filter((tool) => !tool.isVisible || tool.isVisible(options.visibilityContext ?? {}))
    .filter((tool) => options.includeDebugTools === true || tool.debugOnly !== true)
    .filter((tool) => !hideExternalSearchTool || !["ground_with_google_search", "search_with_iqs_lite_advanced"].includes(tool.definition.function.name))
    .filter((tool) => !profileScopedVisibleNames || profileScopedVisibleNames.has(tool.definition.function.name))
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
    forCatalog?: boolean;
    modelRef?: string | string[];
    availableToolNames?: string[];
    includeDebugTools?: boolean;
    operationMode?: SessionOperationMode;
    profileToolScope?: ProfileToolScope | null;
    visibilityContext?: ToolVisibilityContext;
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
    ...(options?.includeDebugTools === true ? { includeDebugTools: true } : {}),
    ...(options?.visibilityContext ? { visibilityContext: options.visibilityContext } : {}),
    profileToolScope: options?.profileToolScope ?? resolveProfileToolScopeFromOperationMode(options?.operationMode)
  })
    .flatMap((tool) => options?.forCatalog ? [tool.definition] : initializationToolDefinition(tool.definition, resolvedConfig?.dataDir, options?.visibilityContext?.sessionId, options?.operationMode));
}

export function getBuiltinToolNames(
  relationship: Relationship,
  currentUserOrConfig?: BuiltinToolContext["currentUser"] | BuiltinToolContext["config"],
  config?: BuiltinToolContext["config"],
  options?: {
    forCatalog?: boolean;
    modelRef?: string | string[];
    availableToolNames?: string[];
    includeDebugTools?: boolean;
    operationMode?: SessionOperationMode;
    profileToolScope?: ProfileToolScope | null;
    visibilityContext?: ToolVisibilityContext;
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
    operationMode?: SessionOperationMode;
    profileToolScope?: ProfileToolScope | null;
    visibilityContext?: ToolVisibilityContext;
  }
): (toolCall: LlmToolCall, args: unknown) => Promise<string | LlmToolExecutionResult> {
  const allowedToolNames = new Set(
    selectBuiltinToolDescriptors({
      relationship: context.relationship,
      currentUser: context.currentUser,
      config: context.config,
      ...(options?.modelRef ? { modelRef: options.modelRef } : {}),
      ...(options?.availableToolNames ? { availableToolNames: options.availableToolNames } : {}),
      ...(options?.includeDebugTools === true ? { includeDebugTools: true } : {}),
      visibilityContext: options?.visibilityContext ?? {
        sessionId: context.lastMessage.sessionId,
        replyDelivery: context.replyDelivery
      },
      profileToolScope: options?.profileToolScope ?? resolveProfileToolScopeFromOperationMode(options?.operationMode)
    })
      .map((tool) => tool.definition.function.name)
  );

  const execute = async (toolCall: LlmToolCall, args: unknown): Promise<string | LlmToolExecutionResult> => {
    if (isCharacterSetupToolName(toolCall.function.name) && allowedToolNames.has("edit_character_section")) {
      return projectRawToolContent(toolCall.function.name, executeCharacterSetupTool(toolCall.function.name, args, context));
    }
    if (!allowedToolNames.has(toolCall.function.name)) {
      return projectRawToolContent(toolCall.function.name, JSON.stringify({
        error: `Tool is not available in the current model toolset: ${toolCall.function.name}`
      }));
    }
    const handler = builtinToolHandlers[toolCall.function.name];
    if (!handler) {
      return projectRawToolContent(toolCall.function.name, JSON.stringify({
        error: `Unsupported contextual tool: ${toolCall.function.name}`
      }));
    }
    const operation = isScenarioSetupToolName(toolCall.function.name) ? context.sessionManager.getOperationMode(context.lastMessage.sessionId) : undefined;
    if (isScenarioSetupTool(toolCall.function.name, operation)) {
      const descriptor = getBuiltinToolDescriptors(context.config).find(tool => tool.definition.function.name === toolCall.function.name)!;
      const schema = initializationToolDefinition(descriptor.definition, context.config.dataDir, context.lastMessage.sessionId, operation)[0]!.function.parameters;
      const errors = setupInputErrors(schema, args);
      if (errors.length) return projectRawToolContent(toolCall.function.name, setupInputFailure(errors, schema));
      try {
        const result = await handler(toolCall, args, context);
        if (typeof result !== "string") return result;
        let parsed: { error?: unknown };
        try { parsed = JSON.parse(result); } catch { return projectRawToolContent(toolCall.function.name, result); }
        if (parsed?.error) return projectRawToolContent(toolCall.function.name, JSON.stringify({ ...parsed, code: "setup_operation_rejected", nextStep: "按错误说明修正字段；涉及条目 ID 时先调用 get_scenario_state 核对。不要原样重复失败调用。", expectedSchema: schema }));
        return projectRawToolContent(toolCall.function.name, result);
      } catch (error) {
        return projectRawToolContent(toolCall.function.name, JSON.stringify({ error: error instanceof Error ? error.message : String(error), code: "setup_operation_rejected", nextStep: "先读取当前草稿或场景状态确认结果，再按错误修正参数；不要原样重试。", expectedSchema: schema }));
      }
    }
    if (["list_character_sections", "read_character_section"].includes(toolCall.function.name)
      && context.sessionManager.getOperationMode(context.lastMessage.sessionId).kind === "character_config") {
      const schema = getBuiltinToolDescriptors(context.config).find(tool => tool.definition.function.name === toolCall.function.name)!.definition.function.parameters;
      const errors = setupInputErrors(schema, args);
      if (errors.length) return projectRawToolContent(toolCall.function.name, setupInputFailure(errors, schema));
    }
    const result = await handler(toolCall, args, context);
    return typeof result === "string"
      ? projectRawToolContent(toolCall.function.name, result)
      : result;
  };
  return async (toolCall, args) => {
    const name = toolCall.function.name;
    const candidate = isCharacterSetupToolName(name) || ["list_character_sections", "read_character_section", "edit_character_section"].includes(name) || isScenarioSetupToolName(name);
    if (!candidate) return execute(toolCall, args);
    const operation = context.sessionManager.getOperationMode(context.lastMessage.sessionId);
    const setup = operation.kind === "character_config" || isScenarioSetupTool(name, operation);
    return setup ? executeSetupAttempt(context, name, args, () => execute(toolCall, args)) : execute(toolCall, args);
  };
}

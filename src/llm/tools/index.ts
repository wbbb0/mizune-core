import { resolveSessionBoundaryToolNames } from "./toolsetBoundary.ts";
import { filterToolNextActions } from "./core/toolNextActions.ts";
import { resolveToolAvailability, projectToolDefinition } from "./core/toolAvailability.ts";
import { characterRepository } from "../../character/repository.ts";
import { executeCharacterSetupTool } from "../../character/setupToolExecution.ts";
import { isCharacterSetupToolName } from "../../character/setupEditing.ts";
import { characterToolNames } from "../../character/tools.ts";
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
import { executeBuiltinToolHandler, getBuiltinToolDescriptors } from "./toolRegistry.ts";
import { projectRawToolContent } from "./core/toolResultProjection.ts";
import { sessionOperationKey, type SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";
import {
  filterProfileToolNamesForScope,
  resolveProfileToolScopeFromOperationMode,
  type ProfileToolScope
} from "./profileToolScope.ts";

interface BuiltinToolSelectionOptions {
  relationship: Relationship;
  currentUser: BuiltinToolContext["currentUser"];
  config?: AppConfig;
  modelRef?: string | string[];
  modeId?: string | null | undefined;
  operationMode?: SessionOperationMode | undefined;
  setupMode?: boolean | undefined;
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
  if (allowedToolNames && [...allowedToolNames].some(isCharacterSetupToolName)) {
    allowedToolNames.add("edit_character_section");
  }
  const hideExternalSearchTool = shouldHideExternalSearchTool(options.config, options.modelRef);
  const modelSupportsTools = !options.config || !options.modelRef
    ? true
    : (getPrimaryModelProfile(options.config, options.modelRef)?.chat?.capabilities.supportsTools ?? true);

  return modelSupportsTools
    ? descriptors
    .filter((tool) => tool.modelVisible !== false)
    .filter((tool) => resolveToolAvailability(tool, options).available)
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
    modeId?: string | null | undefined;
    setupMode?: boolean | undefined;
    operationMode?: SessionOperationMode | undefined;
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
    modeId: options?.modeId,
    operationMode: options?.operationMode,
    setupMode: options?.setupMode,
    currentUser: resolvedCurrentUser,
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(options?.modelRef ? { modelRef: options.modelRef } : {}),
    ...(options?.availableToolNames ? { availableToolNames: options.availableToolNames } : {}),
    ...(options?.includeDebugTools === true ? { includeDebugTools: true } : {}),
    ...(options?.visibilityContext ? { visibilityContext: options.visibilityContext } : {}),
    profileToolScope: options?.profileToolScope ?? resolveProfileToolScopeFromOperationMode(options?.operationMode)
  })
    .flatMap((tool) => options?.forCatalog ? [projectToolDefinition(tool, { config: resolvedConfig, visibilityContext: options?.visibilityContext })] : initializationToolDefinition(projectToolDefinition(tool, { config: resolvedConfig, visibilityContext: options?.visibilityContext }), resolvedConfig?.dataDir, options?.visibilityContext?.sessionId, options?.operationMode))
    .filter(tool => !isCharacterSetupToolName(tool.function.name)
      || options?.availableToolNames === undefined
      || options.availableToolNames.includes("edit_character_section")
      || options.availableToolNames.includes(tool.function.name));
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
    modeId?: string | null | undefined;
    setupMode?: boolean | undefined;
    operationMode?: SessionOperationMode | undefined;
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
    expectedCharacterDraftId?: string | null;
    modelRef?: string | string[];
    availableToolNames?: string[];
    includeDebugTools?: boolean;
    modeId?: string | null | undefined;
    setupMode?: boolean | undefined;
    operationMode?: SessionOperationMode | undefined;
    profileToolScope?: ProfileToolScope | null;
    visibilityContext?: ToolVisibilityContext;
    beforeToolExecution?: (tool: ToolDescriptor, args: unknown, call: LlmToolCall) => string | null;
  }
): (toolCall: LlmToolCall, args: unknown) => Promise<string | LlmToolExecutionResult> {
  const allowedToolNames = new Set(
    selectBuiltinToolDescriptors({
      relationship: context.relationship,
      modeId: context.sessionManager.getSession(context.lastMessage.sessionId)?.modeId,
      operationMode: context.sessionManager.getOperationMode(context.lastMessage.sessionId),
      setupMode: options?.setupMode,
      currentUser: context.currentUser,
      config: context.config,
      ...(options?.modelRef ? { modelRef: options.modelRef } : {}),
      ...(options?.availableToolNames ? { availableToolNames: options.availableToolNames } : {}),
      ...(options?.includeDebugTools === true ? { includeDebugTools: true } : {}),
      visibilityContext: {
        sessionId: context.lastMessage.sessionId,
        replyDelivery: context.replyDelivery,
        modelSelfUpgradeAvailable: options?.visibilityContext?.modelSelfUpgradeAvailable
      },
      profileToolScope: options?.profileToolScope ?? resolveProfileToolScopeFromOperationMode(options?.operationMode)
    })
      .map((tool) => tool.definition.function.name)
  );

  const initialOperation = context.sessionManager.getOperationMode(context.lastMessage.sessionId);
  const expectedDraftId = options?.expectedCharacterDraftId !== undefined
    ? options.expectedCharacterDraftId
    : initialOperation.kind === "character_config"
      ? characterRepository(context.config.dataDir).draft(context.lastMessage.sessionId)?.id ?? null
      : null;

  const resolveCurrentToolNames = () => {
    const currentMode = context.sessionManager.getOperationMode(context.lastMessage.sessionId);
    const currentTools = new Set(selectBuiltinToolDescriptors({
      relationship: context.relationship, currentUser: context.currentUser, config: context.config,
      modeId: context.sessionManager.getSession(context.lastMessage.sessionId)?.modeId,
      operationMode: currentMode,
      setupMode: options?.setupMode,
      ...(options?.modelRef ? { modelRef: options.modelRef } : {}),
      includeDebugTools: options?.includeDebugTools === true,
      visibilityContext: { sessionId: context.lastMessage.sessionId, replyDelivery: context.replyDelivery, modelSelfUpgradeAvailable: options?.visibilityContext?.modelSelfUpgradeAvailable },
      profileToolScope: resolveProfileToolScopeFromOperationMode(currentMode)
    }).map(tool => tool.definition.function.name));
    const session = context.sessionManager.getSession(context.lastMessage.sessionId);
    if (session) {
      const boundary = resolveSessionBoundaryToolNames(session.modeId, session.toolsetPreferences, currentMode);
      for (const name of currentTools) if (!boundary.has(name) && !["list_available_toolsets", "request_toolset", "request_model_upgrade"].includes(name)) currentTools.delete(name);
    }
    return currentTools;
  };

  const execute = async (toolCall: LlmToolCall, args: unknown): Promise<string | LlmToolExecutionResult> => {
    context.abortSignal?.throwIfAborted();
    if (context.resolveActorAuthorization) {
      const actor = await context.resolveActorAuthorization();
      context.abortSignal?.throwIfAborted();
      if (!actor) return projectRawToolContent(toolCall.function.name, JSON.stringify({ error: "触发者身份已变化，本轮工具授权失效。" }));
      context.relationship = actor.relationship;
      context.currentUser = actor.currentUser;
    }
    const currentMode = context.sessionManager.getOperationMode(context.lastMessage.sessionId);
    if (sessionOperationKey(currentMode) !== sessionOperationKey(initialOperation)) return projectRawToolContent(toolCall.function.name, JSON.stringify({ error: "会话配置阶段已变化，本轮工具授权失效。" }));
    const currentTools = resolveCurrentToolNames();
    context.projectionToolNames = [...currentTools].filter(name => allowedToolNames.has(name));
    const baseName = isCharacterSetupToolName(toolCall.function.name) ? "edit_character_section" : toolCall.function.name;
    if (!currentTools.has(baseName)) return projectRawToolContent(toolCall.function.name, JSON.stringify({ error: "当前权限、会话模式或连接能力已不允许此工具。" }));
    const descriptor = getBuiltinToolDescriptors(context.config).find(tool => tool.definition.function.name === baseName);
    if (descriptor && options?.beforeToolExecution && (allowedToolNames.has(toolCall.function.name)
      || (isCharacterSetupToolName(toolCall.function.name) && allowedToolNames.has(baseName)))) {
      const blocked = options.beforeToolExecution(descriptor, args, toolCall);
      if (blocked !== null) return projectRawToolContent(toolCall.function.name, blocked);
    }
    if (isCharacterSetupToolName(toolCall.function.name) && allowedToolNames.has("edit_character_section")
      && (options?.availableToolNames === undefined || options.availableToolNames.includes("edit_character_section")
        || options.availableToolNames.includes(toolCall.function.name))) {
      return projectRawToolContent(toolCall.function.name, await executeCharacterSetupTool(toolCall.function.name, args, context, expectedDraftId));
    }
    if (!allowedToolNames.has(toolCall.function.name)) {
      return projectRawToolContent(toolCall.function.name, JSON.stringify({
        error: `Tool is not available in the current model toolset: ${toolCall.function.name}`
      }));
    }
    const handler = executeBuiltinToolHandler;
    const operation = isScenarioSetupToolName(toolCall.function.name) ? context.sessionManager.getOperationMode(context.lastMessage.sessionId) : undefined;
    if (isScenarioSetupTool(toolCall.function.name, operation)) {
      const descriptor = getBuiltinToolDescriptors(context.config).find(tool => tool.definition.function.name === toolCall.function.name)!;
      const schema = initializationToolDefinition(descriptor.definition, context.config.dataDir, context.lastMessage.sessionId, operation)[0]!.function.parameters;
      const errors = setupInputErrors(schema, args);
      if (errors.length) return projectRawToolContent(toolCall.function.name, setupInputFailure(errors, schema));
      try {
        const result = await handler(toolCall, args, { ...context, expectedCharacterDraftId: expectedDraftId, executionSetupMode: options?.setupMode, ...(options?.modelRef ? { executionModelRef: options.modelRef } : {}) });
        if (typeof result !== "string") return result;
        let parsed: { error?: unknown };
        try { parsed = JSON.parse(result); } catch { return projectRawToolContent(toolCall.function.name, result); }
        if (parsed?.error) return projectRawToolContent(toolCall.function.name, JSON.stringify({ ...parsed, code: "setup_operation_rejected", nextStep: "按错误说明修正字段；涉及条目 ID 时先调用 get_scenario_state 核对。不要原样重复失败调用。", expectedSchema: schema }));
        return projectRawToolContent(toolCall.function.name, result);
      } catch (error) {
        return projectRawToolContent(toolCall.function.name, JSON.stringify({ error: error instanceof Error ? error.message : String(error), code: "setup_operation_rejected", nextStep: "先读取当前草稿或场景状态确认结果，再按错误修正参数；不要原样重试。", expectedSchema: schema }));
      }
    }
    if (["list_character_sections", "read_character_section", "import_character_reference", "send_setup_draft"].includes(toolCall.function.name)
      && context.sessionManager.getOperationMode(context.lastMessage.sessionId).kind === "character_config") {
      const schema = getBuiltinToolDescriptors(context.config).find(tool => tool.definition.function.name === toolCall.function.name)!.definition.function.parameters;
      const errors = setupInputErrors(schema, args);
      if (errors.length) return projectRawToolContent(toolCall.function.name, setupInputFailure(errors, schema));
    }
    const result = await handler(toolCall, args, { ...context, expectedCharacterDraftId: expectedDraftId, executionSetupMode: options?.setupMode, ...(options?.modelRef ? { executionModelRef: options.modelRef } : {}) });
    return typeof result === "string"
      ? projectRawToolContent(toolCall.function.name, result)
      : result;
  };
  return async (toolCall, args) => {
    const name = toolCall.function.name;
    const candidate = isCharacterSetupToolName(name) || characterToolNames.includes(name)
      || name === "send_setup_draft" || isScenarioSetupToolName(name);
    const run = async () => {
      const result = await execute(toolCall, args);
      const content = typeof result === "string" ? result : result.content;
      try {
        const parsed: unknown = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
        const nowAvailable = new Set([...resolveCurrentToolNames()].filter(name => allowedToolNames.has(name)));
        const filtered = JSON.stringify(filterToolNextActions(parsed as Record<string, unknown>, nowAvailable));
        if (typeof result === "string") return filtered;
        let canonicalContent = result.canonicalContent;
        if (canonicalContent) {
          try {
            const canonical: unknown = JSON.parse(canonicalContent);
            if (canonical && typeof canonical === "object" && !Array.isArray(canonical)) canonicalContent = JSON.stringify(filterToolNextActions(canonical as Record<string, unknown>, nowAvailable));
          } catch { /* Non-JSON canonical content has no controlled action envelope. */ }
        }
        return { ...result, content: filtered, ...(canonicalContent !== undefined ? { canonicalContent } : {}) };
      } catch { return result; }
    };
    if (!candidate) return run();
    const operation = context.sessionManager.getOperationMode(context.lastMessage.sessionId);
    const setup = operation.kind === "character_config" || isScenarioSetupTool(name, operation);
    return setup ? executeSetupAttempt(context, name, args, run) : run();
  };
}

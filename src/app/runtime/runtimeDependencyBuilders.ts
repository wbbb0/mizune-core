import type { AppServiceBootstrap } from "../bootstrap/bootstrapTypes.ts";
import type { ComfyTaskRecord } from "#comfy/taskSchema.ts";
import type { InternalSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import type { Scheduler } from "#runtime/scheduler/scheduler.ts";
import type { ContextExtractionQueue } from "#context/contextExtractionQueue.ts";
import type {
  GenerationRunnerDeps,
  GenerationIdentityDeps,
  GenerationLifecycleDeps,
  GenerationPromptBuilderDeps,
  GenerationSessionRuntimeDeps,
  GenerationToolRuntimeDeps
} from "../generation/generationRunnerDeps.ts";

// Keeps the composition root explicit while avoiding one giant unstructured literal.
export function buildGenerationPromptBuilderDeps(services: AppServiceBootstrap): GenerationPromptBuilderDeps {
  return {
    logger: services.logger,
    config: services.config,
    oneBotClient: services.oneBotClient,
    audioStore: services.audioStore,
    audioTranscriber: services.audioTranscriber,
    npcDirectory: services.npcDirectory,
    setupStore: services.setupStore,
    browserService: services.browserService,
    shellRuntime: services.shellRuntime,
    localFileService: services.localFileService,
    chatFileStore: services.chatFileStore,
    mediaVisionService: services.mediaVisionService,
    mediaCaptionService: services.mediaCaptionService,
    contentSafetyService: services.contentSafetyService,
    globalRuleStore: services.globalRuleStore,
    toolsetRuleStore: services.toolsetRuleStore,
    contextStore: services.contextStore,
    contextRetrievalService: services.contextRetrievalService,
    scenarioHostStateStore: services.scenarioHostStateStore
  };
}

export function buildGenerationSessionRuntimeDeps(services: AppServiceBootstrap): GenerationSessionRuntimeDeps {
  return {
    logger: services.logger,
    sessionManager: services.sessionManager,
    llmClient: services.llmClient,
    sessionCaptioner: services.sessionCaptioner,
    turnPlanner: services.turnPlanner,
    debounceManager: services.debounceManager,
    historyCompressor: services.historyCompressor,
    messageQueue: services.messageQueue
  };
}

export function buildGenerationIdentityDeps(services: AppServiceBootstrap): GenerationIdentityDeps {
  return {
    userStore: services.userStore,
    contextStore: services.contextStore,
    whitelistStore: services.whitelistStore,
    personaStore: services.personaStore,
    rpProfileStore: services.rpProfileStore,
    scenarioProfileStore: services.scenarioProfileStore,
    globalRuleStore: services.globalRuleStore,
    toolsetRuleStore: services.toolsetRuleStore,
    scenarioHostStateStore: services.scenarioHostStateStore,
    setupStore: services.setupStore,
    globalProfileReadinessStore: services.globalProfileReadinessStore,
    conversationAccess: services.conversationAccess,
    npcDirectory: services.npcDirectory
  };
}

export function buildGenerationToolRuntimeDeps(services: AppServiceBootstrap): GenerationToolRuntimeDeps {
  return {
    oneBotClient: services.oneBotClient,
    audioStore: services.audioStore,
    requestStore: services.requestStore,
    scheduledJobStore: services.scheduledJobStore,
    shellRuntime: services.shellRuntime,
    searchService: services.searchService,
    browserService: services.browserService,
    localFileService: services.localFileService,
    chatFileStore: services.chatFileStore,
    mediaInspectionService: services.mediaInspectionService,
    forwardResolver: services.forwardResolver,
    comfyClient: services.comfyClient,
    comfyTaskStore: services.comfyTaskStore,
    comfyTemplateCatalog: services.comfyTemplateCatalog
  };
}

export function buildGenerationLifecycleDeps(
  services: AppServiceBootstrap,
  persistSession: (sessionId: string, reason: string) => void,
  getScheduler: () => Scheduler,
  contextExtractionQueue?: Pick<ContextExtractionQueue, "enqueueTurn">
): GenerationLifecycleDeps {
  return {
    logger: services.logger,
    sessionManager: services.sessionManager,
    userStore: services.userStore,
    userIdentityStore: services.userIdentityStore,
    persistSession,
    getScheduler,
    ...(contextExtractionQueue ? { contextExtractionQueue } : {})
  };
}

export function buildSessionWorkCoordinatorDeps(
  services: AppServiceBootstrap,
  persistSession: (sessionId: string, reason: string) => void,
  getScheduler: () => Scheduler,
  contextExtractionQueue?: Pick<ContextExtractionQueue, "enqueueTurn">
): GenerationRunnerDeps {
  return {
    promptBuilder: buildGenerationPromptBuilderDeps(services),
    identity: buildGenerationIdentityDeps(services),
    toolRuntime: buildGenerationToolRuntimeDeps(services),
    lifecycle: buildGenerationLifecycleDeps(services, persistSession, getScheduler, contextExtractionQueue),
    sessionRuntime: buildGenerationSessionRuntimeDeps(services)
  };
}

type DispatchTarget = {
  type: "private" | "group";
  userId: string;
  groupId?: string;
  senderName: string;
};

type SessionWorkDispatcher = {
  dispatchInternalTrigger: (
    sessionId: string,
    triggerFactory: (target: DispatchTarget) => InternalSessionTriggerExecution
  ) => Promise<void>;
};

type ComfyResultFile = {
  fileId: string;
  path: string;
};

export function createComfyTaskNotifications(dispatcher: SessionWorkDispatcher): {
  notifyCompletedTask: (task: ComfyTaskRecord, files: ComfyResultFile[]) => Promise<void>;
  notifyFailedTask: (task: ComfyTaskRecord) => Promise<void>;
} {
  return {
    notifyCompletedTask: async (task, files) => {
      await dispatcher.dispatchInternalTrigger(task.sessionId, (target) => createComfyCompletedTrigger(target, task, files));
    },
    notifyFailedTask: async (task) => {
      await dispatcher.dispatchInternalTrigger(task.sessionId, (target) => createComfyFailedTrigger(target, task));
    }
  };
}

function createComfyCompletedTrigger(
  target: DispatchTarget,
  task: ComfyTaskRecord,
  files: ComfyResultFile[]
): InternalSessionTriggerExecution {
  const base = {
    kind: "comfy_task_completed" as const,
    targetSenderName: target.senderName,
    jobName: `ComfyUI 图片已完成 (${task.templateId})`,
    instruction: "你之前发起的图片生成任务已经完成。系统已把结果导入 workspace，请自行判断接下来要做什么。",
    enqueuedAt: Date.now(),
    taskId: task.id,
    templateId: task.templateId,
    positivePrompt: task.positivePrompt,
    aspectRatio: task.aspectRatio,
    resolvedWidth: task.resolvedWidth,
    resolvedHeight: task.resolvedHeight,
    workspaceFileIds: files.map((item) => item.fileId),
    chatFilePaths: files.map((item) => item.path),
    comfyPromptId: task.comfyPromptId,
    autoIterationIndex: task.autoIterationIndex,
    maxAutoIterations: task.maxAutoIterations
  };

  return target.type === "group"
    ? {
        ...base,
        targetType: "group",
        ...(target.groupId ? { targetGroupId: target.groupId } : {})
      }
    : {
        ...base,
        targetType: "private",
        targetUserId: target.userId
      };
}

function createComfyFailedTrigger(
  target: DispatchTarget,
  task: ComfyTaskRecord
): InternalSessionTriggerExecution {
  const base = {
    kind: "comfy_task_failed" as const,
    targetSenderName: target.senderName,
    jobName: `ComfyUI 图片失败 (${task.templateId})`,
    instruction: "你之前发起的图片生成任务失败了。请自行判断接下来要做什么。",
    enqueuedAt: Date.now(),
    taskId: task.id,
    templateId: task.templateId,
    positivePrompt: task.positivePrompt,
    aspectRatio: task.aspectRatio,
    resolvedWidth: task.resolvedWidth,
    resolvedHeight: task.resolvedHeight,
    comfyPromptId: task.comfyPromptId,
    lastError: task.lastError ?? "Comfy task failed",
    autoIterationIndex: task.autoIterationIndex,
    maxAutoIterations: task.maxAutoIterations
  };

  return target.type === "group"
    ? {
        ...base,
        targetType: "group",
        ...(target.groupId ? { targetGroupId: target.groupId } : {})
      }
    : {
        ...base,
        targetType: "private",
        targetUserId: target.userId
      };
}

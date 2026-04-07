import type { WhitelistStore } from "#identity/whitelistStore.ts";
import { createAppServiceBootstrap } from "../bootstrap/appServiceBootstrap.ts";
import { createAppSetupSupport } from "../bootstrap/appSetupSupport.ts";
import { createSessionWorkCoordinator } from "../session-work/sessionWorkCoordinator.ts";
import { toConfigSummary } from "#config/config.ts";
import { Scheduler } from "#runtime/scheduler/scheduler.ts";
import type { AppLifecycleHooks } from "../../types/common.ts";
import { ComfyTaskRunner } from "#comfy/taskRunner.ts";
import { createMessageListener, createRequestListener } from "./runtimeEvents.ts";
import { createRuntimeMessageIngress } from "./messageIngress.ts";
import {
  shutdownRuntime,
  startInternalApiIfEnabled,
  startSchedulerIfEnabled,
  subscribeRuntimeReload
} from "./runtimeLifecycle.ts";

// Builds and starts the full application runtime on top of the shared service graph.
export async function createAppRuntime(): Promise<AppLifecycleHooks> {
  const services = await createAppServiceBootstrap();
  const {
    config,
    logger,
    dataDir,
    whitelistStore,
    npcDirectory,
    router,
    oneBotClient,
    sessionManager,
    debounceManager,
    llmClient,
    audioStore,
    audioTranscriber,
    historyCompressor,
    replyGate,
    messageQueue,
    sessionPersistence,
    scheduledJobStore,
    requestStore,
    userStore,
    personaStore,
    globalMemoryStore,
    setupStore,
    searchService,
    browserService,
    workspaceService,
    mediaWorkspace,
    mediaVisionService,
    mediaCaptionService,
    comfyClient,
    comfyTaskStore,
    comfyTemplateCatalog,
    forwardResolver,
    conversationAccess,
    shellRuntime,
    configManager,
    singleInstanceLock
  } = services;

  logger.info(
    {
      startup: toConfigSummary(
        { ...config, dataDir },
        summarizeWhitelist(whitelistStore)
      )
    },
    "application_started"
  );

  const {
    persistSession,
    sendImmediateText,
    notifyOwnerSetupIfNeeded,
    assignOwner
  } = createAppSetupSupport({
    logger,
    oneBotClient,
    sessionManager,
    sessionPersistence,
    personaStore,
    setupStore,
    whitelistStore,
    userStore
  });

  let sessionWorkCoordinator!: ReturnType<typeof createSessionWorkCoordinator>;
  let comfyTaskRunner!: ComfyTaskRunner;

  let scheduler!: Scheduler;
  let schedulerStarted = false;
  sessionWorkCoordinator = createSessionWorkCoordinator({
    config,
    logger,
    llmClient,
    replyGate,
    debounceManager,
    historyCompressor,
    messageQueue,
    oneBotClient,
    sessionManager,
    audioTranscriber,
    audioStore,
    requestStore,
    whitelistStore,
    scheduledJobStore,
    shellRuntime,
    searchService,
    browserService,
    workspaceService,
    mediaWorkspace,
    mediaVisionService,
    mediaCaptionService,
    comfyClient,
    comfyTaskStore,
    comfyTemplateCatalog,
    forwardResolver,
    userStore,
    personaStore,
    globalMemoryStore,
    setupStore,
    conversationAccess,
    npcDirectory,
    persistSession,
    getScheduler: () => scheduler
  });

  scheduler = new Scheduler(
    scheduledJobStore,
    logger,
    async (job) => {
      for (const target of job.targets) {
        await sessionWorkCoordinator.dispatchScheduledPrompt({
          sessionId: target.sessionId,
          jobName: job.name,
          instruction: job.instruction
        });
      }
    }
  );

  comfyTaskRunner = new ComfyTaskRunner({
    config,
    logger,
    comfyClient,
    comfyTaskStore,
    mediaWorkspace,
    notifyCompletedTask: async (task, assets) => {
      await sessionWorkCoordinator.dispatchInternalTrigger(task.sessionId, (target) => target.type === "group"
        ? {
            kind: "comfy_task_completed",
            targetType: "group",
            ...(target.groupId ? { targetGroupId: target.groupId } : {}),
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
            workspaceAssetIds: assets.map((item) => item.assetId),
            workspacePaths: assets.map((item) => item.path),
            comfyPromptId: task.comfyPromptId,
            autoIterationIndex: task.autoIterationIndex,
            maxAutoIterations: task.maxAutoIterations
          }
        : {
            kind: "comfy_task_completed",
            targetType: "private",
            targetUserId: target.userId,
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
            workspaceAssetIds: assets.map((item) => item.assetId),
            workspacePaths: assets.map((item) => item.path),
            comfyPromptId: task.comfyPromptId,
            autoIterationIndex: task.autoIterationIndex,
            maxAutoIterations: task.maxAutoIterations
          });
    },
    notifyFailedTask: async (task) => {
      await sessionWorkCoordinator.dispatchInternalTrigger(task.sessionId, (target) => target.type === "group"
        ? {
            kind: "comfy_task_failed",
            targetType: "group",
            ...(target.groupId ? { targetGroupId: target.groupId } : {}),
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
          }
        : {
            kind: "comfy_task_failed",
            targetType: "private",
            targetUserId: target.userId,
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
          });
    }
  });

  const messageIngress = createRuntimeMessageIngress({
    services: {
      config,
      logger,
      whitelistStore,
      router,
      oneBotClient,
      sessionManager,
      debounceManager,
      audioStore,
      mediaWorkspace,
      mediaCaptionService,
      requestStore,
      userStore,
      setupStore,
      conversationAccess
    },
    directCommandDeps: {
      config,
      sessionManager,
      oneBotClient,
      logger,
      historyCompressor,
      setupStore,
      whitelistStore,
      persistSession,
      flushSession: (sessionId, options) => sessionWorkCoordinator.flushSession(sessionId, options),
      onebotSendImmediateText: sendImmediateText,
      assignOwner: async ({ requesterUserId, targetUserId, chatType }) => assignOwner({
        requesterUserId,
        targetUserId,
        chatType
      })
    },
    persistSession
  });

  const handleWebIncomingMessage = async (
    incomingMessage: import("#services/onebot/types.ts").ParsedIncomingMessage,
    options: {
      webOutputCollector: import("../generation/generationExecutor.ts").GenerationWebOutputCollector;
    }
  ) => {
    await messageIngress.handleIncomingMessage(incomingMessage, {
      kind: "web",
      collector: options.webOutputCollector
    });
  };

  const onMessage = createMessageListener(logger, messageIngress.handleMessageEvent);
  const onRequest = createRequestListener(logger, requestStore);

  try {
    if (config.onebot.enabled) {
      await oneBotClient.start();

      // Register listeners ONLY AFTER client is started to avoid double processing during transitions
      oneBotClient.on("message", onMessage);
      oneBotClient.on("request", onRequest);

      await notifyOwnerSetupIfNeeded();
    } else {
      logger.info("onebot_disabled_startup_skipped");
    }

    schedulerStarted = await startSchedulerIfEnabled(config, scheduler, logger);
    await comfyTaskRunner.start();

    let internalApi = await startInternalApiIfEnabled({
      config,
      logger,
      oneBotClient,
      sessionManager,
      personaStore,
      globalMemoryStore,
      userStore,
      whitelistStore,
      requestStore,
      scheduledJobStore,
      scheduler,
      shellRuntime,
      configManager,
      sessionPersistence,
      persistSession,
      flushSession: sessionWorkCoordinator.flushSession,
      handleWebIncomingMessage,
      browserService,
      workspaceService,
      mediaWorkspace,
      mediaVisionService,
      mediaCaptionService
    });

    subscribeRuntimeReload({
      configManager,
      config,
      logger,
      oneBotClient,
      browserService,
      workspaceService,
      mediaWorkspace,
      mediaVisionService,
      mediaCaptionService,
      searchService,
      scheduler,
      comfyTemplateCatalog,
      comfyTaskRunner,
      isSchedulerStarted: () => schedulerStarted,
      setSchedulerStarted: (value) => {
        schedulerStarted = value;
      },
      getInternalApi: () => internalApi,
      setInternalApi: (value) => {
        internalApi = value;
      },
      sessionManager,
      personaStore,
      globalMemoryStore,
      userStore,
      whitelistStore,
      requestStore,
      scheduledJobStore,
      shellRuntime,
      sessionPersistence,
      persistSession,
      flushSession: sessionWorkCoordinator.flushSession,
      handleWebIncomingMessage
    });
    await configManager.start();

    if (config.whitelist.enabled && isWhitelistEmpty(whitelistStore)) {
      logger.warn("whitelist_enabled_but_empty");
    }

    return {
      shutdown: async () => {
        await shutdownRuntime({
          configManager,
          oneBotClient,
          onMessage,
          onRequest,
          internalApi,
          schedulerStarted,
          scheduler,
          comfyTaskRunner,
          singleInstanceLock,
          logger
        });
      }
    };
  } catch (error) {
    await singleInstanceLock.release();
    throw error;
  }
}

function summarizeWhitelist(whitelistStore: WhitelistStore): { userWhitelistSize: number; groupWhitelistSize: number } {
  const snapshot = whitelistStore.getSnapshot();
  return {
    userWhitelistSize: snapshot.users.length,
    groupWhitelistSize: snapshot.groups.length
  };
}

function isWhitelistEmpty(whitelistStore: WhitelistStore): boolean {
  const snapshot = whitelistStore.getSnapshot();
  return snapshot.users.length === 0 && snapshot.groups.length === 0;
}

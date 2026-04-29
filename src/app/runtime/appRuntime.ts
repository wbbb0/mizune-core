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
import { buildSessionWorkCoordinatorDeps, createComfyTaskNotifications } from "./runtimeDependencyBuilders.ts";
import { createInternalApiServices } from "#internalApi/types.ts";
import {
  shutdownRuntime,
  startInternalApiIfEnabled,
  startSchedulerIfEnabled,
  subscribeRuntimeReload
} from "./runtimeLifecycle.ts";
import { backfillOneBotSessionHistory } from "./oneBotHistoryBackfill.ts";
import { createOneBotStartupIngressGate } from "./oneBotStartupIngressGate.ts";

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
    sessionCaptioner,
    audioStore,
    audioTranscriber,
    historyCompressor,
    turnPlanner,
    messageQueue,
    sessionPersistence,
    scheduledJobStore,
    requestStore,
    userIdentityStore,
    userStore,
    personaStore,
    rpProfileStore,
    scenarioProfileStore,
    globalRuleStore,
    toolsetRuleStore,
    scenarioHostStateStore,
    setupStore,
    globalProfileReadinessStore,
    searchService,
    browserService,
    localFileService,
    chatFileStore,
    chatMessageFileGcService,
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
    userIdentityStore,
    userStore
  });

  let sessionWorkCoordinator!: ReturnType<typeof createSessionWorkCoordinator>;
  let comfyTaskRunner!: ComfyTaskRunner;

  let scheduler!: Scheduler;
  let schedulerStarted = false;
  sessionWorkCoordinator = createSessionWorkCoordinator(
    buildSessionWorkCoordinatorDeps(services, persistSession, () => scheduler)
  );

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

  const comfyTaskNotifications = createComfyTaskNotifications(sessionWorkCoordinator);
  comfyTaskRunner = new ComfyTaskRunner({
    config,
    logger,
    comfyClient,
    comfyTaskStore,
    chatFileStore,
    notifyCompletedTask: comfyTaskNotifications.notifyCompletedTask,
    notifyFailedTask: comfyTaskNotifications.notifyFailedTask
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
      chatFileStore,
      mediaCaptionService,
      requestStore,
      userIdentityStore,
      userStore,
      personaStore,
      rpProfileStore,
      scenarioProfileStore,
      setupStore,
      globalProfileReadinessStore,
      conversationAccess
    },
    directCommandDeps: {
      config,
      sessionManager,
      oneBotClient,
      logger,
      sessionCaptioner,
      historyCompressor,
      setupStore,
      personaStore,
      rpProfileStore,
      scenarioProfileStore,
      globalProfileReadinessStore,
      userIdentityStore,
      scenarioHostStateStore,
      persistSession,
      flushSession: (sessionId, options) => sessionWorkCoordinator.flushSession(sessionId, options),
      onebotSendImmediateText: sendImmediateText,
      assignOwner: async ({ channelId, requesterUserId, targetUserId, chatType }) => assignOwner({
        channelId,
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
      committedTextSink: import("../generation/generationOutputContracts.ts").GenerationCommittedTextSink;
      draftOverlaySink?: import("../generation/generationOutputContracts.ts").GenerationDraftOverlaySink;
      sessionId?: string;
    }
  ) => {
    await messageIngress.handleIncomingMessage(incomingMessage, {
      kind: "web",
      committedTextSink: options.committedTextSink,
      ...(options.draftOverlaySink ? { draftOverlaySink: options.draftOverlaySink } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {})
    });
  };

  const oneBotStartupIngressGate = createOneBotStartupIngressGate({
    logger,
    handleMessageEvent: messageIngress.handleMessageEvent,
    handleRequestEvent: (event) => requestStore.upsertFromEvent(event)
  });
  const onMessage = createMessageListener(logger, oneBotStartupIngressGate.handleMessageEvent);
  const onRequest = createRequestListener(logger, {
    upsertFromEvent: oneBotStartupIngressGate.handleRequestEvent
  });
  const internalApiServices = createInternalApiServices({
    config,
    logger,
    oneBotClient,
    sessionManager,
    sessionCaptioner,
    personaStore,
    globalRuleStore,
    scenarioHostStateStore,
    userStore,
    whitelistStore,
    userIdentityStore,
    requestStore,
    scheduledJobStore,
    scheduler,
    shellRuntime,
    configManager,
    sessionPersistence,
    handleWebIncomingMessage,
    browserService,
    localFileService,
    chatFileStore,
    audioStore,
    chatMessageFileGcService
  });

  try {
    if (config.onebot.enabled) {
      oneBotClient.on("message", onMessage);
      oneBotClient.on("request", onRequest);
      const oneBotHistoryImportBeforeMs = Date.now();
      await oneBotClient.start();
      await backfillOneBotSessionHistory({
        config,
        logger,
        importBeforeMs: oneBotHistoryImportBeforeMs,
        oneBotClient,
        sessionManager,
        audioStore,
        chatFileStore,
        userIdentityStore,
        userStore,
        setupStore,
        persistSession
      });
      await oneBotStartupIngressGate.open();

      await notifyOwnerSetupIfNeeded();
    } else {
      logger.info("onebot_disabled_startup_skipped");
    }

    schedulerStarted = await startSchedulerIfEnabled(config, scheduler, logger);
    await comfyTaskRunner.start();

    let internalApi = await startInternalApiIfEnabled({
      config,
      logger,
      services: internalApiServices
    });

    subscribeRuntimeReload({
      configManager,
      config,
      logger,
      oneBotClient,
      browserService,
      localFileService,
      chatFileStore,
      chatMessageFileGcService,
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
      services: internalApiServices
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

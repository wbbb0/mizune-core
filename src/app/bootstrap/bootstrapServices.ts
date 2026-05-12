import { ConversationAccessService } from "#identity/conversationAccessService.ts";
import { ContextEmbeddingService } from "#context/contextEmbeddingService.ts";
import { ContextRetrievalService } from "#context/contextRetrievalService.ts";
import { ContextStore } from "#context/contextStore.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import { GroupMembershipStore } from "#identity/groupMembershipStore.ts";
import { NpcDirectory } from "#identity/npcDirectory.ts";
import { WhitelistStore } from "#identity/whitelistStore.ts";
import { ConfigManager } from "#config/configManager.ts";
import { DebounceManager } from "../../conversation/debounceManager.ts";
import { HistoryCompressor } from "../../conversation/historyCompressor.ts";
import { MessageQueue } from "../../conversation/messageQueue.ts";
import { TurnPlanner } from "../../conversation/turnPlanner.ts";
import { SessionManager } from "#conversation/session/sessionManager.ts";
import { SessionPersistence } from "#conversation/session/sessionPersistence.ts";
import { ForwardResolver } from "../../forwards/forwardResolver.ts";
import { AudioStore } from "#audio/audioStore.ts";
import { AudioTranscriber } from "#audio/audioTranscriber.ts";
import { LlmClient } from "#llm/llmClient.ts";
import { PersonaStore } from "#persona/personaStore.ts";
import { RequestStore } from "#requests/requestStore.ts";
import { ScheduledJobStore } from "#runtime/scheduler/jobStore.ts";
import { SetupStateStore } from "#identity/setupStateStore.ts";
import { GlobalProfileReadinessStore } from "#identity/globalProfileReadinessStore.ts";
import { UserIdentityStore } from "#identity/userIdentityStore.ts";
import { UserStore } from "#identity/userStore.ts";
import { GlobalRuleStore } from "#memory/globalRuleStore.ts";
import { EventRouter } from "#services/onebot/eventRouter.ts";
import { OneBotClient } from "#services/onebot/onebotClient.ts";
import { ShellRuntime } from "#services/shell/runtime.ts";
import { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import { DownloadRuntime } from "#services/workspace/downloadRuntime.ts";
import { AssetLifecycleService } from "#data/assets/assetLifecycleService.ts";
import { AssetLifecycleStore } from "#data/assets/assetLifecycleStore.ts";
import { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import { MediaInspectionService } from "#services/workspace/mediaInspectionService.ts";
import { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import { DocumentSummaryService } from "#services/workspace/documentSummaryService.ts";
import { TextInspectionService } from "#services/workspace/textInspectionService.ts";
import { LocalFileService } from "#services/workspace/localFileService.ts";
import { ContentSafetyService } from "#contentSafety/contentSafetyService.ts";
import { ContentSafetyStore } from "#contentSafety/contentSafetyStore.ts";
import { BrowserService, createBrowserServiceDeps } from "#services/web/browser/browserService.ts";
import { SearchService } from "#services/web/search/searchService.ts";
import { ComfyClient } from "#comfy/comfyClient.ts";
import { ComfyTaskStore } from "#comfy/taskStore.ts";
import { ComfyTemplateCatalogService } from "#comfy/templateCatalogService.ts";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "#runtime/resources/runtimeResourceStore.ts";
import { ToolsetRuleStore } from "#llm/prompt/toolsetRuleStore.ts";
import { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";
import { RpProfileStore } from "#modes/rpAssistant/profileStore.ts";
import { ScenarioProfileStore } from "#modes/scenarioHost/profileStore.ts";
import type { SessionBootstrapPersistenceAccess } from "#conversation/session/sessionCapabilities.ts";
import { SessionCaptioner } from "#app/generation/sessionCaptioner.ts";
import { isOwnerBootstrapCommandText } from "./ownerBootstrapPolicy.ts";
import type { AppBootstrapServices, AppServiceBootstrap, BootstrapRuntimeContext } from "./bootstrapTypes.ts";
import { resolvePersonaReadinessStatus } from "#persona/personaSetupPolicy.ts";

export function createBootstrapServices(
  context: BootstrapRuntimeContext,
  options: {
    oneBotClient?: OneBotClient;
  } = {}
): AppBootstrapServices {
  const { config, logger, dataDir } = context;
  const stateDatabase = new StateDatabase(dataDir, logger);
  const whitelistStore = new WhitelistStore(dataDir, logger, stateDatabase);
  const userIdentityStore = new UserIdentityStore(dataDir, logger, stateDatabase);
  const npcDirectory = new NpcDirectory();
  const router = new EventRouter(
    config,
    config.configRuntime.instanceName,
    whitelistStore,
    userIdentityStore,
    (userId) => npcDirectory.isNpc(userId),
    isOwnerBootstrapCommandText
  );
  const oneBotClient = options.oneBotClient ?? new OneBotClient(config, logger);
  const sessionManager = new SessionManager(config);
  const debounceManager = new DebounceManager(logger, sessionManager, config);
  const llmClient = new LlmClient(config, logger);
  const audioStore = new AudioStore(dataDir, logger);
  const audioTranscriber = new AudioTranscriber(config, llmClient, audioStore, oneBotClient, logger);
  const localFileService = new LocalFileService(config, dataDir);
  const chatFileStore = new ChatFileStore(config, logger, localFileService, dataDir);
  const downloadRuntime = new DownloadRuntime(config, logger, dataDir, chatFileStore);
  const contentSafetyStore = new ContentSafetyStore(dataDir, logger);
  const contentSafetyService = new ContentSafetyService(config, logger, contentSafetyStore, chatFileStore, audioStore);
  const mediaVisionService = new MediaVisionService(config, logger, chatFileStore, contentSafetyService);
  const mediaCaptionService = new MediaCaptionService(config, llmClient, chatFileStore, mediaVisionService, logger, contentSafetyService);
  const mediaInspectionService = new MediaInspectionService(config, llmClient, logger);
  const textInspectionService = new TextInspectionService(config, llmClient, logger);
  const documentSummaryService = new DocumentSummaryService(config, llmClient, logger);
  const sessionCaptioner = new SessionCaptioner(config, llmClient, logger, mediaCaptionService);
  const comfyClient = new ComfyClient(config, logger);
  const comfyTaskStore = new ComfyTaskStore(dataDir, logger);
  const assetLifecycleStore = new AssetLifecycleStore(dataDir, logger);
  const assetLifecycleService = new AssetLifecycleService(
    assetLifecycleStore,
    {
      chatFileStore,
      audioStore,
      comfyTaskStore
    },
    logger,
    config.assets.gc
  );
  const comfyTemplateCatalog = new ComfyTemplateCatalogService(config, logger);
  const historyCompressor = new HistoryCompressor(config, llmClient, sessionManager, mediaCaptionService, logger, chatFileStore);
  const turnPlanner = new TurnPlanner(config, llmClient, chatFileStore, mediaVisionService, logger, mediaCaptionService);
  const messageQueue = new MessageQueue(logger, config);
  const sessionPersistence = new SessionPersistence(dataDir, logger);
  const scheduledJobStore = new ScheduledJobStore(dataDir, logger, stateDatabase);
  const requestStore = new RequestStore(dataDir, logger, stateDatabase);
  const groupMembershipStore = new GroupMembershipStore(dataDir, logger, stateDatabase);
  const userStore = new UserStore(dataDir, config, logger, stateDatabase);
  const contextStore = new ContextStore(dataDir, config, logger);
  const contextEmbeddingService = new ContextEmbeddingService(config, llmClient, logger);
  const contextRetrievalService = new ContextRetrievalService(config, contextStore, contextEmbeddingService, logger);
  const personaStore = new PersonaStore(dataDir, config, logger, stateDatabase);
  const globalRuleStore = new GlobalRuleStore(dataDir, config, logger, stateDatabase);
  const toolsetRuleStore = new ToolsetRuleStore(dataDir, config, logger, stateDatabase);
  const scenarioHostStateStore = new ScenarioHostStateStore(dataDir, config, logger);
  const rpProfileStore = new RpProfileStore(dataDir, config, logger, stateDatabase);
  const scenarioProfileStore = new ScenarioProfileStore(dataDir, config, logger, stateDatabase);
  const setupStore = new SetupStateStore(dataDir, config, userIdentityStore, logger, stateDatabase);
  const globalProfileReadinessStore = new GlobalProfileReadinessStore(dataDir, config, logger, stateDatabase);
  const searchService = new SearchService(config, logger);
  const runtimeResourceStore = new RuntimeResourceStore(stateDatabase);
  const sharedResourceRegistry = new RuntimeResourceRegistry(runtimeResourceStore);
  const browserService = new BrowserService(createBrowserServiceDeps({
    config,
    logger,
    resolveSearchRef: (refId) => searchService.resolveReference(refId),
    dataDir,
    chatFileStore,
    resourceRegistry: sharedResourceRegistry
  }));
  const forwardResolver = new ForwardResolver(oneBotClient, logger);
  const conversationAccess = new ConversationAccessService(
    sessionManager,
    oneBotClient,
    npcDirectory,
    groupMembershipStore,
    userIdentityStore,
    logger
  );
  const shellRuntime = new ShellRuntime(config, logger, sharedResourceRegistry);

  return {
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
    groupMembershipStore,
    userIdentityStore,
    userStore,
    contextStore,
    contextEmbeddingService,
    contextRetrievalService,
    personaStore,
    globalRuleStore,
    toolsetRuleStore,
    scenarioHostStateStore,
    rpProfileStore,
    scenarioProfileStore,
    setupStore,
    globalProfileReadinessStore,
    searchService,
    browserService,
    localFileService,
    chatFileStore,
    downloadRuntime,
    assetLifecycleStore,
    assetLifecycleService,
    contentSafetyStore,
    contentSafetyService,
    mediaVisionService,
    mediaCaptionService,
    mediaInspectionService,
    textInspectionService,
    documentSummaryService,
    comfyClient,
    comfyTaskStore,
    comfyTemplateCatalog,
    forwardResolver,
    conversationAccess,
    shellRuntime,
    runtimeResourceRegistry: sharedResourceRegistry,
    runtimeResourceStore
  };
}

export async function initializeBootstrapState(
  services: Omit<
    Pick<
      AppServiceBootstrap,
      | "config"
      | "logger"
      | "dataDir"
      | "whitelistStore"
      | "sessionPersistence"
      | "audioStore"
      | "localFileService"
      | "chatFileStore"
      | "assetLifecycleService"
      | "mediaVisionService"
      | "mediaCaptionService"
      | "comfyTaskStore"
      | "comfyTemplateCatalog"
      | "scheduledJobStore"
      | "requestStore"
      | "groupMembershipStore"
      | "userIdentityStore"
      | "userStore"
      | "contextStore"
      | "npcDirectory"
      | "personaStore"
      | "globalRuleStore"
      | "toolsetRuleStore"
      | "scenarioHostStateStore"
      | "rpProfileStore"
      | "scenarioProfileStore"
      | "setupStore"
      | "globalProfileReadinessStore"
      | "sessionManager"
      | "runtimeResourceRegistry"
    >,
    "sessionManager"
  > & {
    sessionManager: SessionBootstrapPersistenceAccess;
    contentSafetyStore?: ContentSafetyStore;
  }
): Promise<void> {
  const {
    logger,
    dataDir,
    config,
    whitelistStore,
    sessionPersistence,
    audioStore,
    localFileService,
    chatFileStore,
    assetLifecycleService,
    contentSafetyStore,
    mediaVisionService,
    mediaCaptionService,
    comfyTaskStore,
    comfyTemplateCatalog,
    scheduledJobStore,
    requestStore,
    groupMembershipStore,
    userIdentityStore,
    userStore,
    contextStore,
    npcDirectory,
    personaStore,
    globalRuleStore,
    toolsetRuleStore,
    scenarioHostStateStore,
    rpProfileStore,
    scenarioProfileStore,
    setupStore,
    globalProfileReadinessStore,
    sessionManager,
    runtimeResourceRegistry
  } = services;

  await runtimeResourceRegistry.reset();
  await whitelistStore.init();
  await sessionPersistence.init();
  await localFileService.init();
  await chatFileStore.init();
  await assetLifecycleService.init();
  await contentSafetyStore?.init();
  await audioStore.init();
  await comfyTaskStore.init();
  await comfyTemplateCatalog.init();
  await scheduledJobStore.init();
  await requestStore.init();
  await groupMembershipStore.init();
  await userIdentityStore.init();
  await userStore.init();
  await contextStore.init();
  await npcDirectory.refresh(userStore);
  await personaStore.init();
  await globalRuleStore.init();
  await toolsetRuleStore.init();
  await scenarioHostStateStore.init();
  await rpProfileStore.init();
  await scenarioProfileStore.init();
  const currentPersona = await personaStore.get();
  const currentRpProfile = await rpProfileStore.get();
  const currentScenarioProfile = await scenarioProfileStore.get();
  await setupStore.init(currentPersona);
  await globalProfileReadinessStore.init();
  await globalProfileReadinessStore.setPersonaReadiness(
    resolvePersonaReadinessStatus(config, currentPersona)
  );
  await globalProfileReadinessStore.setRpReadiness(
    rpProfileStore.isComplete(currentRpProfile) ? "ready" : "uninitialized"
  );
  await globalProfileReadinessStore.setScenarioReadiness(
    scenarioProfileStore.isComplete(currentScenarioProfile) ? "ready" : "uninitialized"
  );
  const persistedSessions = await sessionPersistence.loadAll();
  sessionManager.restoreSessions(persistedSessions);
  await assetLifecycleService.sweep({
    activeSessions: sessionManager.listSessions(),
    persistedSessions
  });

  if (persistedSessions.length > 0) {
    logger.info({ restoredSessionCount: persistedSessions.length }, "session_restore_completed");
  }
}

export function createBootstrapConfigManager(context: BootstrapRuntimeContext): ConfigManager {
  return new ConfigManager(context.config, context.logger);
}

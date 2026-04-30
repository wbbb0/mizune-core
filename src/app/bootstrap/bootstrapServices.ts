import { ConversationAccessService } from "#identity/conversationAccessService.ts";
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
import { ChatMessageFileGcService } from "#services/workspace/chatMessageFileGcService.ts";
import { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import { MediaInspectionService } from "#services/workspace/mediaInspectionService.ts";
import { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import { LocalFileService } from "#services/workspace/localFileService.ts";
import { ContentSafetyService } from "#contentSafety/contentSafetyService.ts";
import { ContentSafetyStore } from "#contentSafety/contentSafetyStore.ts";
import { BrowserService, createBrowserServiceDeps } from "#services/web/browser/browserService.ts";
import { SearchService } from "#services/web/search/searchService.ts";
import { ComfyClient } from "#comfy/comfyClient.ts";
import { ComfyTaskStore } from "#comfy/taskStore.ts";
import { ComfyTemplateCatalogService } from "#comfy/templateCatalogService.ts";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import { ToolsetRuleStore } from "#llm/prompt/toolsetRuleStore.ts";
import { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";
import { RpProfileStore } from "#modes/rpAssistant/profileStore.ts";
import { ScenarioProfileStore } from "#modes/scenarioHost/profileStore.ts";
import type { SessionBootstrapPersistenceAccess } from "#conversation/session/sessionCapabilities.ts";
import { SessionCaptioner } from "#app/generation/sessionCaptioner.ts";
import { isOwnerBootstrapCommandText } from "./ownerBootstrapPolicy.ts";
import type { AppBootstrapServices, AppServiceBootstrap, BootstrapRuntimeContext } from "./bootstrapTypes.ts";
import { resolvePersonaReadinessStatus } from "#persona/personaSetupPolicy.ts";

export function createBootstrapServices(context: BootstrapRuntimeContext): AppBootstrapServices {
  const { config, logger, dataDir } = context;
  const whitelistStore = new WhitelistStore(dataDir, logger);
  const userIdentityStore = new UserIdentityStore(dataDir, logger);
  const npcDirectory = new NpcDirectory();
  const router = new EventRouter(
    config,
    config.configRuntime.instanceName,
    whitelistStore,
    userIdentityStore,
    (userId) => npcDirectory.isNpc(userId),
    isOwnerBootstrapCommandText
  );
  const oneBotClient = new OneBotClient(config, logger);
  const sessionManager = new SessionManager(config);
  const debounceManager = new DebounceManager(logger, sessionManager, config);
  const llmClient = new LlmClient(config, logger);
  const audioStore = new AudioStore(dataDir);
  const audioTranscriber = new AudioTranscriber(config, llmClient, audioStore, oneBotClient, logger);
  const localFileService = new LocalFileService(config, dataDir);
  const chatFileStore = new ChatFileStore(config, logger, localFileService);
  const chatMessageFileGcService = new ChatMessageFileGcService(
    chatFileStore,
    logger,
    config.chatFiles.gcGracePeriodMs
  );
  const contentSafetyStore = new ContentSafetyStore(dataDir, logger);
  const contentSafetyService = new ContentSafetyService(config, logger, contentSafetyStore, chatFileStore);
  const mediaVisionService = new MediaVisionService(config, logger, chatFileStore, contentSafetyService);
  const mediaCaptionService = new MediaCaptionService(config, llmClient, chatFileStore, mediaVisionService, logger, contentSafetyService);
  const mediaInspectionService = new MediaInspectionService(config, llmClient, logger);
  const sessionCaptioner = new SessionCaptioner(config, llmClient, logger, mediaCaptionService);
  const comfyClient = new ComfyClient(config, logger);
  const comfyTaskStore = new ComfyTaskStore(dataDir, logger);
  const comfyTemplateCatalog = new ComfyTemplateCatalogService(config, logger);
  const historyCompressor = new HistoryCompressor(config, llmClient, sessionManager, mediaCaptionService, logger, chatFileStore);
  const turnPlanner = new TurnPlanner(config, llmClient, chatFileStore, mediaVisionService, logger, mediaCaptionService);
  const messageQueue = new MessageQueue(logger, config);
  const sessionPersistence = new SessionPersistence(dataDir, logger);
  const scheduledJobStore = new ScheduledJobStore(dataDir, logger);
  const requestStore = new RequestStore(dataDir, logger);
  const groupMembershipStore = new GroupMembershipStore(dataDir, logger);
  const userStore = new UserStore(dataDir, config, logger);
  const personaStore = new PersonaStore(dataDir, config, logger);
  const globalRuleStore = new GlobalRuleStore(dataDir, config, logger);
  const toolsetRuleStore = new ToolsetRuleStore(dataDir, config, logger);
  const scenarioHostStateStore = new ScenarioHostStateStore(dataDir, config, logger);
  const rpProfileStore = new RpProfileStore(dataDir, config, logger);
  const scenarioProfileStore = new ScenarioProfileStore(dataDir, config, logger);
  const setupStore = new SetupStateStore(dataDir, config, userIdentityStore, logger);
  const globalProfileReadinessStore = new GlobalProfileReadinessStore(dataDir, config, logger);
  const searchService = new SearchService(config, logger);
  const browserService = new BrowserService(createBrowserServiceDeps({
    config,
    logger,
    resolveSearchRef: (refId) => searchService.resolveReference(refId),
    dataDir,
    chatFileStore
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
  const shellRuntime = new ShellRuntime(config, logger, dataDir);

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
    chatMessageFileGcService,
    contentSafetyStore,
    contentSafetyService,
    mediaVisionService,
    mediaCaptionService,
    mediaInspectionService,
    comfyClient,
    comfyTaskStore,
    comfyTemplateCatalog,
    forwardResolver,
    conversationAccess,
    shellRuntime
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
      | "chatMessageFileGcService"
      | "mediaVisionService"
      | "mediaCaptionService"
      | "comfyTaskStore"
      | "comfyTemplateCatalog"
      | "scheduledJobStore"
      | "requestStore"
      | "groupMembershipStore"
      | "userIdentityStore"
      | "userStore"
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
    chatMessageFileGcService,
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
    npcDirectory,
    personaStore,
    globalRuleStore,
    toolsetRuleStore,
    scenarioHostStateStore,
    rpProfileStore,
    scenarioProfileStore,
    setupStore,
    globalProfileReadinessStore,
    sessionManager
  } = services;

  await new RuntimeResourceRegistry(dataDir, logger).reset();
  await whitelistStore.init();
  await sessionPersistence.init();
  await localFileService.init();
  await chatFileStore.init();
  await contentSafetyStore?.init();
  await audioStore.init();
  await comfyTaskStore.init();
  await comfyTemplateCatalog.init();
  await scheduledJobStore.init();
  await requestStore.init();
  await groupMembershipStore.init();
  await userIdentityStore.init();
  await userStore.init();
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
  await chatMessageFileGcService.sweep({
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

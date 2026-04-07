import { ConversationAccessService } from "#identity/conversationAccessService.ts";
import { GroupMembershipStore } from "#identity/groupMembershipStore.ts";
import { NpcDirectory } from "#identity/npcDirectory.ts";
import { WhitelistStore } from "#identity/whitelistStore.ts";
import { ConfigManager } from "#config/configManager.ts";
import { DebounceManager } from "../../conversation/debounceManager.ts";
import { HistoryCompressor } from "../../conversation/historyCompressor.ts";
import { MessageQueue } from "../../conversation/messageQueue.ts";
import { ReplyGate } from "../../conversation/replyGate.ts";
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
import { UserStore } from "#identity/userStore.ts";
import { GlobalMemoryStore } from "#memory/memoryStore.ts";
import { EventRouter } from "#services/onebot/eventRouter.ts";
import { OneBotClient } from "#services/onebot/onebotClient.ts";
import { ShellRuntime } from "#services/shell/runtime.ts";
import { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import { WorkspaceService } from "#services/workspace/workspaceService.ts";
import { BrowserService } from "#services/web/browser/browserService.ts";
import { SearchService } from "#services/web/search/searchService.ts";
import { ComfyClient } from "#comfy/comfyClient.ts";
import { ComfyTaskStore } from "#comfy/taskStore.ts";
import { ComfyTemplateCatalogService } from "#comfy/templateCatalogService.ts";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import { isOwnerBootstrapCommandText } from "../messaging/directCommands.ts";
import type { AppBootstrapServices, AppServiceBootstrap, BootstrapRuntimeContext } from "./bootstrapTypes.ts";

export function createBootstrapServices(context: BootstrapRuntimeContext): AppBootstrapServices {
  const { config, logger, dataDir } = context;
  const whitelistStore = new WhitelistStore(dataDir, logger);
  const npcDirectory = new NpcDirectory();
  const router = new EventRouter(
    config,
    whitelistStore,
    (userId) => npcDirectory.isNpc(userId),
    isOwnerBootstrapCommandText
  );
  const oneBotClient = new OneBotClient(config, logger);
  const sessionManager = new SessionManager(config);
  const debounceManager = new DebounceManager(logger, sessionManager, config);
  const llmClient = new LlmClient(config, logger);
  const audioStore = new AudioStore(dataDir);
  const audioTranscriber = new AudioTranscriber(config, llmClient, audioStore, oneBotClient, logger);
  const workspaceService = new WorkspaceService(config, dataDir);
  const mediaWorkspace = new MediaWorkspace(config, logger, workspaceService);
  const mediaVisionService = new MediaVisionService(config, logger, mediaWorkspace);
  const mediaCaptionService = new MediaCaptionService(config, llmClient, mediaWorkspace, mediaVisionService, logger);
  const comfyClient = new ComfyClient(config, logger);
  const comfyTaskStore = new ComfyTaskStore(dataDir, logger);
  const comfyTemplateCatalog = new ComfyTemplateCatalogService(config, logger);
  const historyCompressor = new HistoryCompressor(config, llmClient, sessionManager, mediaCaptionService, logger);
  const replyGate = new ReplyGate(config, llmClient, mediaWorkspace, mediaVisionService, logger);
  const messageQueue = new MessageQueue(logger);
  const sessionPersistence = new SessionPersistence(dataDir, logger);
  const scheduledJobStore = new ScheduledJobStore(dataDir, logger);
  const requestStore = new RequestStore(dataDir, logger);
  const groupMembershipStore = new GroupMembershipStore(dataDir, logger);
  const userStore = new UserStore(dataDir, config, whitelistStore, logger);
  const personaStore = new PersonaStore(dataDir, config, logger);
  const globalMemoryStore = new GlobalMemoryStore(dataDir, config, logger);
  const setupStore = new SetupStateStore(dataDir, whitelistStore, logger);
  const searchService = new SearchService(config, logger);
  const browserService = new BrowserService(
    config,
    logger,
    (refId) => searchService.resolveReference(refId),
    dataDir,
    mediaWorkspace
  );
  const forwardResolver = new ForwardResolver(oneBotClient, logger);
  const conversationAccess = new ConversationAccessService(
    sessionManager,
    oneBotClient,
    npcDirectory,
    groupMembershipStore,
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
    audioStore,
    audioTranscriber,
    historyCompressor,
    replyGate,
    messageQueue,
    sessionPersistence,
    scheduledJobStore,
    requestStore,
    groupMembershipStore,
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
    shellRuntime
  };
}

export async function initializeBootstrapState(
  services: Pick<
    AppServiceBootstrap,
    | "logger"
    | "dataDir"
    | "whitelistStore"
    | "sessionPersistence"
    | "audioStore"
    | "workspaceService"
    | "mediaWorkspace"
    | "mediaVisionService"
    | "mediaCaptionService"
    | "comfyTaskStore"
    | "comfyTemplateCatalog"
    | "scheduledJobStore"
    | "requestStore"
    | "groupMembershipStore"
    | "userStore"
    | "npcDirectory"
    | "personaStore"
    | "globalMemoryStore"
    | "setupStore"
    | "sessionManager"
  >
): Promise<void> {
  const {
    logger,
    dataDir,
    whitelistStore,
    sessionPersistence,
    audioStore,
    workspaceService,
    mediaWorkspace,
    mediaVisionService,
    mediaCaptionService,
    comfyTaskStore,
    comfyTemplateCatalog,
    scheduledJobStore,
    requestStore,
    groupMembershipStore,
    userStore,
    npcDirectory,
    personaStore,
    globalMemoryStore,
    setupStore,
    sessionManager
  } = services;

  await new RuntimeResourceRegistry(dataDir, logger).reset();
  await whitelistStore.init();
  await sessionPersistence.init();
  await workspaceService.init();
  await mediaWorkspace.init();
  await audioStore.init();
  await comfyTaskStore.init();
  await comfyTemplateCatalog.init();
  await scheduledJobStore.init();
  await requestStore.init();
  await groupMembershipStore.init();
  await userStore.init();
  await npcDirectory.refresh(userStore);
  await personaStore.init();
  await globalMemoryStore.init();
  await setupStore.init(await personaStore.get());
  const persistedSessions = await sessionPersistence.loadAll();
  sessionManager.restoreSessions(persistedSessions);

  if (persistedSessions.length > 0) {
    logger.info({ restoredSessionCount: persistedSessions.length }, "session_restore_completed");
  }
}

export function createBootstrapConfigManager(context: BootstrapRuntimeContext): ConfigManager {
  return new ConfigManager(context.config, context.logger);
}

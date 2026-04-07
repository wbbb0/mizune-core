import type { ConversationAccessService } from "#identity/conversationAccessService.ts";
import type { GroupMembershipStore } from "#identity/groupMembershipStore.ts";
import type { NpcDirectory } from "#identity/npcDirectory.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import type { ConfigManager } from "#config/configManager.ts";
import type { DebounceManager } from "../../conversation/debounceManager.ts";
import type { HistoryCompressor } from "../../conversation/historyCompressor.ts";
import type { MessageQueue } from "../../conversation/messageQueue.ts";
import type { ReplyGate } from "../../conversation/replyGate.ts";
import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { SessionPersistence } from "#conversation/session/sessionPersistence.ts";
import type { ForwardResolver } from "../../forwards/forwardResolver.ts";
import type { AudioStore } from "#audio/audioStore.ts";
import type { AudioTranscriber } from "#audio/audioTranscriber.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import type { createLogger } from "../../logger.ts";
import type { PersonaStore } from "#persona/personaStore.ts";
import type { RequestStore } from "#requests/requestStore.ts";
import type { SingleInstanceLock } from "#runtime/singleInstanceLock.ts";
import type { ScheduledJobStore } from "#runtime/scheduler/jobStore.ts";
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { GlobalMemoryStore } from "#memory/memoryStore.ts";
import type { loadConfig } from "#config/config.ts";
import type { EventRouter } from "#services/onebot/eventRouter.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { ShellRuntime } from "#services/shell/runtime.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { WorkspaceService } from "#services/workspace/workspaceService.ts";
import type { BrowserService } from "#services/web/browser/browserService.ts";
import type { SearchService } from "#services/web/search/searchService.ts";
import type { ComfyClient } from "#comfy/comfyClient.ts";
import type { ComfyTaskStore } from "#comfy/taskStore.ts";
import type { ComfyTemplateCatalogService } from "#comfy/templateCatalogService.ts";

export interface AppServiceBootstrap {
  config: ReturnType<typeof loadConfig>;
  logger: ReturnType<typeof createLogger>;
  dataDir: string;
  whitelistStore: WhitelistStore;
  npcDirectory: NpcDirectory;
  router: EventRouter;
  oneBotClient: OneBotClient;
  sessionManager: SessionManager;
  debounceManager: DebounceManager;
  llmClient: LlmClient;
  audioStore: AudioStore;
  audioTranscriber: AudioTranscriber;
  historyCompressor: HistoryCompressor;
  replyGate: ReplyGate;
  messageQueue: MessageQueue;
  sessionPersistence: SessionPersistence;
  scheduledJobStore: ScheduledJobStore;
  requestStore: RequestStore;
  groupMembershipStore: GroupMembershipStore;
  userStore: UserStore;
  personaStore: PersonaStore;
  globalMemoryStore: GlobalMemoryStore;
  setupStore: SetupStateStore;
  searchService: SearchService;
  browserService: BrowserService;
  workspaceService: WorkspaceService;
  mediaWorkspace: MediaWorkspace;
  mediaVisionService: MediaVisionService;
  mediaCaptionService: MediaCaptionService;
  comfyClient: ComfyClient;
  comfyTaskStore: ComfyTaskStore;
  comfyTemplateCatalog: ComfyTemplateCatalogService;
  forwardResolver: ForwardResolver;
  conversationAccess: ConversationAccessService;
  shellRuntime: ShellRuntime;
  configManager: ConfigManager;
  singleInstanceLock: SingleInstanceLock;
}

export interface BootstrapRuntimeContext {
  config: AppServiceBootstrap["config"];
  logger: AppServiceBootstrap["logger"];
  dataDir: string;
  singleInstanceLock: SingleInstanceLock;
}

export type AppBootstrapServices = Omit<
  AppServiceBootstrap,
  "config" | "logger" | "dataDir" | "configManager" | "singleInstanceLock"
>;

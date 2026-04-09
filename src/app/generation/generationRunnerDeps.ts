import type { Logger } from "pino";
import type { ConversationAccessService } from "#identity/conversationAccessService.ts";
import type { NpcDirectory } from "#identity/npcDirectory.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { AppConfig } from "#config/config.ts";
import type { DebounceManager } from "../../conversation/debounceManager.ts";
import type { HistoryCompressor } from "../../conversation/historyCompressor.ts";
import type { MessageQueue } from "../../conversation/messageQueue.ts";
import type { TurnPlanner } from "../../conversation/turnPlanner.ts";
import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { ForwardResolver } from "../../forwards/forwardResolver.ts";
import type { AudioStore } from "#audio/audioStore.ts";
import type { AudioTranscriber } from "#audio/audioTranscriber.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import type { PersonaStore } from "#persona/personaStore.ts";
import type { RequestStore } from "#requests/requestStore.ts";
import type { ScheduledJobStore } from "#runtime/scheduler/jobStore.ts";
import type { Scheduler } from "#runtime/scheduler/scheduler.ts";
import type { BrowserService } from "#services/web/browser/browserService.ts";
import type { SearchService } from "#services/web/search/searchService.ts";
import type { ShellRuntime } from "#services/shell/runtime.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { WorkspaceService } from "#services/workspace/workspaceService.ts";
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { GlobalMemoryStore } from "#memory/memoryStore.ts";
import type { SessionWorkPersistenceDeps } from "../session-work/sessionWorkCoreDeps.ts";
import type { ComfyClient } from "#comfy/comfyClient.ts";
import type { ComfyTaskStore } from "#comfy/taskStore.ts";
import type { ComfyTemplateCatalogService } from "#comfy/templateCatalogService.ts";

export interface GenerationPromptBuilderDeps {
  config: AppConfig;
  oneBotClient: OneBotClient;
  audioStore: AudioStore;
  audioTranscriber: AudioTranscriber;
  npcDirectory: NpcDirectory;
  setupStore: SetupStateStore;
  browserService: BrowserService;
  shellRuntime: ShellRuntime;
  workspaceService: WorkspaceService;
  mediaWorkspace: MediaWorkspace;
  mediaVisionService: MediaVisionService;
  mediaCaptionService: MediaCaptionService;
  globalMemoryStore: GlobalMemoryStore;
}

export interface GenerationSessionRuntimeDeps {
  logger: Logger;
  sessionManager: SessionManager;
  llmClient: LlmClient;
  turnPlanner: TurnPlanner;
  debounceManager: DebounceManager;
  historyCompressor: HistoryCompressor;
  messageQueue: MessageQueue;
}

export interface GenerationIdentityDeps {
  userStore: UserStore;
  whitelistStore: WhitelistStore;
  personaStore: PersonaStore;
  globalMemoryStore: GlobalMemoryStore;
  setupStore: SetupStateStore;
  conversationAccess: ConversationAccessService;
  npcDirectory: NpcDirectory;
}

export interface GenerationToolRuntimeDeps {
  oneBotClient: OneBotClient;
  audioStore: AudioStore;
  requestStore: RequestStore;
  scheduledJobStore: ScheduledJobStore;
  shellRuntime: ShellRuntime;
  searchService: SearchService;
  browserService: BrowserService;
  workspaceService: WorkspaceService;
  mediaWorkspace: MediaWorkspace;
  forwardResolver: ForwardResolver;
  comfyClient: ComfyClient;
  comfyTaskStore: ComfyTaskStore;
  comfyTemplateCatalog: ComfyTemplateCatalogService;
}

export interface GenerationLifecycleDeps extends SessionWorkPersistenceDeps {
  persistSession: (sessionId: string, reason: string) => void;
  getScheduler: () => Scheduler;
}

export interface GenerationRunnerDeps extends
  GenerationPromptBuilderDeps,
  GenerationSessionRuntimeDeps,
  GenerationIdentityDeps,
  GenerationToolRuntimeDeps,
  GenerationLifecycleDeps {}

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
import type {
  SessionGenerationRuntimeAccess,
  SessionGenerationOrchestratorAccess,
  SessionGenerationOutboundAccess,
  SessionTurnPlannerAccess
} from "#conversation/session/sessionCapabilities.ts";
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
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { LocalFileService } from "#services/workspace/localFileService.ts";
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { GlobalRuleStore } from "#memory/globalRuleStore.ts";
import type { SessionWorkPersistenceDeps } from "../session-work/sessionWorkCoreDeps.ts";
import type { ComfyClient } from "#comfy/comfyClient.ts";
import type { ComfyTaskStore } from "#comfy/taskStore.ts";
import type { ComfyTemplateCatalogService } from "#comfy/templateCatalogService.ts";
import type { ToolsetRuleStore } from "#llm/prompt/toolsetRuleStore.ts";
import type { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";

// These dependency contracts describe the generation pipeline in domain-shaped slices.
// The broad runtime bundle still exists at the composition root, but lower-level modules
// should depend on the narrowest type below that matches the use case they own.
export interface GenerationPromptBuilderDeps {
  logger?: Logger;
  config: AppConfig;
  oneBotClient: OneBotClient;
  audioStore: AudioStore;
  audioTranscriber: AudioTranscriber;
  npcDirectory: NpcDirectory;
  setupStore: SetupStateStore;
  browserService: BrowserService;
  shellRuntime: ShellRuntime;
  localFileService: LocalFileService;
  chatFileStore: ChatFileStore;
  mediaVisionService: MediaVisionService;
  mediaCaptionService: MediaCaptionService;
  globalRuleStore: GlobalRuleStore;
  toolsetRuleStore: ToolsetRuleStore;
  scenarioHostStateStore: ScenarioHostStateStore;
}

export interface GenerationSessionRuntimeDeps {
  logger: Logger;
  sessionManager: SessionGenerationRuntimeAccess;
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
  globalRuleStore: GlobalRuleStore;
  toolsetRuleStore: ToolsetRuleStore;
  scenarioHostStateStore: ScenarioHostStateStore;
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
  localFileService: LocalFileService;
  chatFileStore: ChatFileStore;
  forwardResolver: ForwardResolver;
  comfyClient: ComfyClient;
  comfyTaskStore: ComfyTaskStore;
  comfyTemplateCatalog: ComfyTemplateCatalogService;
}

export interface GenerationLifecycleDeps extends SessionWorkPersistenceDeps {
  persistSession: (sessionId: string, reason: string) => void;
  getScheduler: () => Scheduler;
}

export interface GenerationRunnerDeps {
  promptBuilder: GenerationPromptBuilderDeps;
  sessionRuntime: GenerationSessionRuntimeDeps;
  identity: GenerationIdentityDeps;
  toolRuntime: GenerationToolRuntimeDeps;
  lifecycle: GenerationLifecycleDeps;
}

export type GenerationCurrentUser = Awaited<ReturnType<GenerationIdentityDeps["userStore"]["getByUserId"]>>;
export type GenerationPersona = Awaited<ReturnType<GenerationIdentityDeps["personaStore"]["get"]>>;

export type GenerationTurnPlannerDeps =
  Pick<GenerationPromptBuilderDeps, "config">
  & Pick<GenerationSessionRuntimeDeps, "logger" | "llmClient" | "turnPlanner" | "debounceManager" | "historyCompressor">
  & Pick<GenerationLifecycleDeps, "persistSession">
  & {
    sessionManager: SessionTurnPlannerAccess;
  };

export type GenerationOutboundDeps =
  Pick<GenerationSessionRuntimeDeps, "logger" | "messageQueue">
  & Pick<GenerationToolRuntimeDeps, "oneBotClient">
  & Pick<GenerationLifecycleDeps, "persistSession">
  & {
    sessionManager: SessionGenerationOutboundAccess;
  };

export type GenerationExecutorDeps =
  Pick<GenerationRunnerDeps, "sessionRuntime" | "identity" | "toolRuntime" | "lifecycle">
  & {
    promptBuilder: Pick<GenerationPromptBuilderDeps, "config" | "mediaVisionService" | "mediaCaptionService">;
  };

export type GenerationSessionOrchestratorDeps =
  Pick<GenerationRunnerDeps, "lifecycle">
  & {
    promptBuilder: Pick<GenerationPromptBuilderDeps, "config">;
    sessionRuntime: Pick<GenerationSessionRuntimeDeps, "logger" | "historyCompressor" | "llmClient" | "turnPlanner" | "debounceManager"> & {
      sessionManager: SessionGenerationOrchestratorAccess;
    };
    identity: Pick<GenerationIdentityDeps, "userStore" | "personaStore" | "setupStore" | "scenarioHostStateStore">;
  };

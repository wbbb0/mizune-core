import type { PersonaStore } from "#persona/personaStore.ts";
import type { RequestStore } from "#requests/requestStore.ts";
import type { Scheduler } from "#runtime/scheduler/scheduler.ts";
import type { ScheduledJobSchedule } from "#runtime/scheduler/types.ts";
import type { ScheduledJobStore } from "#runtime/scheduler/jobStore.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { MessageQueue } from "#conversation/messageQueue.ts";
import type { AppConfig } from "#config/config.ts";
import type { ForwardResolver } from "#forwards/forwardResolver.ts";
import type { AudioStore } from "#audio/audioStore.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { LlmToolCall, LlmToolDefinition, LlmToolExecutionResult } from "../../llmClient.ts";
import type { ShellRuntime } from "#services/shell/runtime.ts";
import type { SearchService } from "#services/web/search/searchService.ts";
import type { BrowserService } from "#services/web/browser/browserService.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { LocalFileService } from "#services/workspace/localFileService.ts";
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { ConversationAccessService } from "#identity/conversationAccessService.ts";
import type { NpcDirectory } from "#identity/npcDirectory.ts";
import type { GlobalRuleStore } from "#memory/globalRuleStore.ts";
import type { ToolsetRuleStore, ToolsetRuleEntry } from "#llm/prompt/toolsetRuleStore.ts";
import type { ComfyClient } from "#comfy/comfyClient.ts";
import type { ComfyTaskStore } from "#comfy/taskStore.ts";
import type { ComfyTemplateCatalogService } from "#comfy/templateCatalogService.ts";
import type {
  SessionToolRuntimeAccess
} from "#conversation/session/sessionCapabilities.ts";
import type {
  InternalTranscriptItem,
  InternalSessionTriggerExecution,
  SessionDebugMarker,
  SessionUsageSnapshot
} from "#conversation/session/sessionTypes.ts";
import type {
  GenerationPromptBatchMessage,
  GenerationPromptHistoryMessage,
  GenerationPromptParticipantProfile,
  GenerationPromptToolEvent
} from "#app/generation/generationPromptBuilder.ts";
import type { PromptLiveResource } from "../../prompt/promptTypes.ts";
import type { Persona } from "#persona/personaSchema.ts";
import type { GenerationWebOutputCollector } from "#app/generation/generationTypes.ts";
import type { SessionDelivery } from "#conversation/session/sessionTypes.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import type { SessionModeDefinition } from "#modes/types.ts";
import type { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";

export type Relationship = "owner" | "known";
export type ToolAccessLevel = "any" | "owner" | "operator";

export interface ToolDescriptor {
  definition: LlmToolDefinition;
  accessLevel?: ToolAccessLevel;
  ownerOnly?: boolean;
  debugOnly?: boolean;
  modelVisible?: boolean;
  isEnabled?: (config: AppConfig) => boolean;
}

export interface BuiltinToolActorContext {
  config: AppConfig;
  relationship: Relationship;
  replyDelivery: SessionDelivery;
  lastMessage: {
    sessionId: string;
    userId: string;
    senderName: string;
  };
  currentUser: Awaited<ReturnType<UserStore["getByUserId"]>>;
}

export interface BuiltinToolCommunicationDeps {
  oneBotClient: OneBotClient;
  audioStore: AudioStore;
  chatFileStore: ChatFileStore;
  mediaVisionService: MediaVisionService;
  mediaCaptionService: MediaCaptionService;
  forwardResolver: ForwardResolver;
}

export interface BuiltinToolStoreDeps {
  requestStore: RequestStore;
  sessionManager: SessionToolRuntimeAccess;
  whitelistStore: WhitelistStore;
  userStore: UserStore;
  personaStore: PersonaStore;
  globalRuleStore: GlobalRuleStore;
  toolsetRuleStore: ToolsetRuleStore;
  scenarioHostStateStore: ScenarioHostStateStore;
  setupStore: SetupStateStore;
  conversationAccess: ConversationAccessService;
  npcDirectory: NpcDirectory;
}

export interface BuiltinToolRuntimeDeps {
  scheduledJobStore: ScheduledJobStore;
  scheduler: Scheduler;
  messageQueue: MessageQueue;
  shellRuntime: ShellRuntime;
  searchService: SearchService;
  browserService: BrowserService;
  localFileService: LocalFileService;
  comfyClient: ComfyClient;
  comfyTaskStore: ComfyTaskStore;
  comfyTemplateCatalog: ComfyTemplateCatalogService;
}

export interface PromptDebugSnapshot {
  sessionId: string;
  systemMessages: string[];
  visibleToolNames: string[];
  activeToolsets: ToolsetView[];
  historySummary: string | null;
  recentHistory: GenerationPromptHistoryMessage[];
  currentBatch: GenerationPromptBatchMessage[];
  liveResources: PromptLiveResource[];
  recentToolEvents: GenerationPromptToolEvent[];
  debugMarkers: SessionDebugMarker[];
  toolTranscript: InternalTranscriptItem[];
  persona: Persona;
  globalRules: Awaited<ReturnType<GlobalRuleStore["getAll"]>>;
  toolsetRules: ToolsetRuleEntry[];
  currentUser: Awaited<ReturnType<UserStore["getByUserId"]>>;
  participantProfiles: GenerationPromptParticipantProfile[];
  imageCaptions: Array<{ imageId: string; caption: string }>;
  lastLlmUsage: SessionUsageSnapshot | null;
}

export interface BuiltinToolContext extends
  BuiltinToolActorContext,
  BuiltinToolCommunicationDeps,
  BuiltinToolStoreDeps,
  BuiltinToolRuntimeDeps {
  toolsetAccess?: {
    listAvailableToolsets: () => {
      available_toolsets: Array<{
        id: string;
        title: string;
        description: string;
        tools: string[];
      }>;
      active_toolset_ids: string[];
      request_limit_per_turn: number;
      remaining_request_quota: number;
    };
    requestToolsets: (toolsetIds: string[], reason: string) => {
      ok: boolean;
      requested_toolset_ids: string[];
      approved_toolset_ids: string[];
      rejected_toolset_ids: string[];
      active_toolset_ids: string[];
      reason: string | null;
      message: string;
    };
  };
  webOutputCollector?: GenerationWebOutputCollector;
  debugSnapshot?: PromptDebugSnapshot;
  activeInternalTrigger?: InternalSessionTriggerExecution | null;
  persistSession?: (sessionId: string, reason: string) => void;
  listSessionModes?: () => SessionModeDefinition[];
}

export type ToolHandler = (toolCall: LlmToolCall, args: unknown, context: BuiltinToolContext) => Promise<string | LlmToolExecutionResult>;

export function buildBuiltinToolContext(
  context: BuiltinToolContext
): BuiltinToolContext {
  return context;
}

export function requireOwner(relationship: Relationship, error: string): string | null {
  return relationship === "owner" ? null : JSON.stringify({ error });
}

export function isNpcOperator(context: BuiltinToolContext): boolean {
  return context.relationship === "owner" || context.currentUser?.specialRole === "npc";
}

export function requireOperator(context: BuiltinToolContext, error: string): string | null {
  return isNpcOperator(context) ? null : JSON.stringify({ error });
}

export function parseScheduledJobSchedule(
  input: unknown,
  defaultTimezone: string
): ScheduledJobSchedule | { error: string } {
  if (typeof input !== "object" || input == null || !("kind" in input)) {
    return { error: "schedule.kind is required" };
  }

  const kind = String((input as { kind: unknown }).kind);
  if (kind === "delay") {
    const delayMs = Number((input as { delayMs?: unknown }).delayMs);
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      return { error: "delay schedule requires positive delayMs" };
    }
    return {
      kind: "delay",
      delayMs: Math.round(delayMs)
    };
  }

  if (kind === "at") {
    const runAtMs = Number((input as { runAtMs?: unknown }).runAtMs);
    const runAtIso = String((input as { runAtIso?: unknown }).runAtIso ?? "").trim();
    const tz = String((input as { tz?: unknown }).tz ?? defaultTimezone).trim();
    const parsedFromIso = runAtIso ? Date.parse(runAtIso) : Number.NaN;
    const resolvedRunAtMs = Number.isFinite(runAtMs) && runAtMs > 0
      ? Math.round(runAtMs)
      : (Number.isFinite(parsedFromIso) ? Math.round(parsedFromIso) : Number.NaN);
    if (!Number.isFinite(resolvedRunAtMs) || resolvedRunAtMs <= 0) {
      return { error: "at schedule requires positive runAtMs" };
    }
    return {
      kind: "at",
      runAtMs: resolvedRunAtMs,
      tz: tz || defaultTimezone
    };
  }

  if (kind === "cron") {
    const expr = String((input as { expr?: unknown }).expr ?? "").trim();
    const tz = String((input as { tz?: unknown }).tz ?? defaultTimezone).trim();
    if (!expr) {
      return { error: "cron schedule requires expr" };
    }
    return {
      kind: "cron",
      expr,
      tz: tz || defaultTimezone
    };
  }

  return { error: `Unsupported schedule kind: ${kind}` };
}

import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import type { UserIdentityStore } from "#identity/userIdentityStore.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { PersonaStore } from "#persona/personaStore.ts";
import type { GlobalRuleStore } from "#memory/globalRuleStore.ts";
import type { RequestStore } from "#requests/requestStore.ts";
import type { ScheduledJobStore } from "#runtime/scheduler/jobStore.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { ShellRuntime } from "#services/shell/runtime.ts";
import type { SessionPersistence } from "#conversation/session/sessionPersistence.ts";
import type { ConfigManager } from "#config/configManager.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type {
  GenerationCommittedTextSink,
  GenerationDraftOverlaySink
} from "#app/generation/generationOutputContracts.ts";
import type { BrowserService } from "#services/web/browser/browserService.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { ContentSafetyStore } from "#contentSafety/contentSafetyStore.ts";
import type { ChatMessageFileGcService } from "#services/workspace/chatMessageFileGcService.ts";
import type { LocalFileService } from "#services/workspace/localFileService.ts";
import type { AudioStore } from "#audio/audioStore.ts";
import type { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";
import type { SessionCaptioner } from "#app/generation/sessionCaptioner.ts";
import type {
  SessionAdminMutationAccess,
  SessionAdminReadAccess,
  SessionStreamAccess,
} from "#conversation/session/sessionCapabilities.ts";
import type { SessionParticipantRef, SessionTitleSource } from "#conversation/session/sessionTypes.ts";
import {
  createEditorService,
  type EditorService
} from "./application/editorService.ts";
import type { Scheduler } from "#runtime/scheduler/scheduler.ts";
import {
  createDataBrowserService,
  type DataBrowserService
} from "./application/dataBrowserService.ts";
import {
  createLocalFileAdminService,
  type LocalFileAdminService
} from "./application/localFileAdminService.ts";
import type { DerivedObservation } from "#llm/derivations/derivedObservation.ts";
import type { ContentSafetyAuditView } from "#contentSafety/contentSafetyTypes.ts";

// Domain-shaped dependency slices keep route/application code from depending on
// the full internal API service graph when a smaller contract is enough.
export interface InternalApiConfigSummaryDeps {
  config: AppConfig;
  whitelistStore: WhitelistStore;
  userIdentityStore: UserIdentityStore;
}

export interface InternalApiUserDeps {
  userStore: UserStore;
}

export interface InternalApiSessionSummary {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  modeId: string;
  participantRef: SessionParticipantRef;
  title: string | null;
  titleSource: SessionTitleSource | null;
  isGenerating: boolean;
  lastActiveAt: number;
}

export interface InternalApiSessionDetail {
  session: {
    id: string;
    type: "private" | "group";
    source: "onebot" | "web";
    modeId: string;
    participantRef: SessionParticipantRef;
    title: string | null;
    titleSource: SessionTitleSource | null;
    titleGenerationAvailable: boolean;
    debugControl: {
      enabled: boolean;
      oncePending: boolean;
    };
    historySummary: string | null;
    derivedObservations: DerivedObservation[];
    internalTranscript: unknown[];
    debugMarkers: unknown[];
    lastLlmUsage: unknown;
    sentMessages: unknown[];
    contentSafetyAudits: ContentSafetyAuditView[];
    lastActiveAt: number;
    isGenerating: boolean;
    historyRevision: number;
    mutationEpoch: number;
  };
  modeState: unknown;
}

export interface InternalApiSessionReadDeps {
  config?: AppConfig;
  sessionManager: SessionAdminReadAccess;
  scenarioHostStateStore: ScenarioHostStateStore;
  sessionCaptioner: SessionCaptioner;
  chatFileStore: Pick<ChatFileStore, "getMany">;
  audioStore: Pick<AudioStore, "getMany">;
  contentSafetyStore?: Pick<ContentSafetyStore, "listBySessionId" | "getViewByFileId">;
}

export interface InternalApiSessionWriteDeps extends InternalApiSessionReadDeps {
  sessionManager: SessionAdminReadAccess & SessionAdminMutationAccess;
  sessionPersistence: SessionPersistence;
  scenarioHostStateStore: ScenarioHostStateStore;
  sessionCaptioner: SessionCaptioner;
}

export interface InternalApiSessionDeleteDeps extends InternalApiSessionReadDeps {
  sessionManager: SessionAdminReadAccess & Pick<SessionAdminMutationAccess, "deleteSession">;
  sessionPersistence: SessionPersistence;
  chatMessageFileGcService: ChatMessageFileGcService;
}

export interface InternalApiPersonaDeps {
  personaStore: PersonaStore;
}

export interface InternalApiWhitelistDeps {
  whitelistStore: WhitelistStore;
}

export interface InternalApiOperationsDeps {
  requestStore: RequestStore;
  scheduledJobStore: ScheduledJobStore;
}

export interface InternalApiMessagingDeps {
  config: AppConfig;
  oneBotClient: OneBotClient;
  sessionManager: SessionStreamAccess & Pick<SessionAdminMutationAccess, "excludeTranscriptItem" | "excludeTranscriptGroup">;
  handleWebIncomingMessage: (
    incomingMessage: ParsedIncomingMessage,
    options: {
      committedTextSink: GenerationCommittedTextSink;
      draftOverlaySink?: GenerationDraftOverlaySink;
      sessionId?: string;
    }
  ) => Promise<void>;
  chatFileStore: ChatFileStore;
}

export interface InternalApiUploadsDeps {
  chatFileStore: ChatFileStore;
  logger: Pick<Logger, "warn">;
}

export interface InternalApiShellDeps {
  shellRuntime: ShellRuntime;
}

export interface InternalApiBrowserDeps {
  browserService: BrowserService;
}

export interface InternalApiWorkspaceDeps {
  localFileService: LocalFileService;
  chatFileStore: ChatFileStore;
  oneBotClient: OneBotClient;
}

export interface InternalApiDeps {
  config: AppConfig;
  logger: Logger;
  oneBotClient: OneBotClient;
  sessionManager: SessionAdminReadAccess & SessionAdminMutationAccess & SessionStreamAccess;
  sessionCaptioner: SessionCaptioner;
  personaStore: PersonaStore;
  globalRuleStore: GlobalRuleStore;
  scenarioHostStateStore: ScenarioHostStateStore;
  userStore: UserStore;
  whitelistStore: WhitelistStore;
  userIdentityStore: UserIdentityStore;
  requestStore: RequestStore;
  scheduledJobStore: ScheduledJobStore;
  scheduler: Scheduler;
  shellRuntime: ShellRuntime;
  configManager: ConfigManager;
  sessionPersistence: SessionPersistence;
  handleWebIncomingMessage: (
    incomingMessage: ParsedIncomingMessage,
    options: {
      committedTextSink: GenerationCommittedTextSink;
      draftOverlaySink?: GenerationDraftOverlaySink;
      sessionId?: string;
    }
  ) => Promise<void>;
  browserService: BrowserService;
  localFileService: LocalFileService;
  chatFileStore: ChatFileStore;
  audioStore: AudioStore;
  contentSafetyStore?: ContentSafetyStore;
  chatMessageFileGcService: ChatMessageFileGcService;
}

export interface InternalApiServices {
  basicRoutes: {
    config: InternalApiConfigSummaryDeps & InternalApiSessionWriteDeps & InternalApiSessionDeleteDeps & InternalApiPersonaDeps & InternalApiUserDeps & {
      globalRuleStore: GlobalRuleStore;
    };
    editor: EditorService;
    dataBrowser: DataBrowserService;
    localFileAdmin: LocalFileAdminService;
    operations: InternalApiOperationsDeps;
    workspace: InternalApiWorkspaceDeps;
  };
  messagingRoutes: InternalApiMessagingDeps;
  uploadRoutes: InternalApiUploadsDeps;
  shellRoutes: InternalApiShellDeps;
  browserRoutes: InternalApiBrowserDeps;
}

export interface InternalApiRuntimeDeps {
  config: AppConfig;
  logger: Logger;
  services: InternalApiServices;
}

export function createInternalApiServices(deps: InternalApiDeps): InternalApiServices {
  return {
    basicRoutes: {
      config: {
        config: deps.config,
        whitelistStore: deps.whitelistStore,
        userIdentityStore: deps.userIdentityStore,
        sessionManager: deps.sessionManager,
      sessionPersistence: deps.sessionPersistence,
      personaStore: deps.personaStore,
      globalRuleStore: deps.globalRuleStore,
      scenarioHostStateStore: deps.scenarioHostStateStore,
      sessionCaptioner: deps.sessionCaptioner,
      chatFileStore: deps.chatFileStore,
      audioStore: deps.audioStore,
      ...(deps.contentSafetyStore ? { contentSafetyStore: deps.contentSafetyStore } : {}),
      userStore: deps.userStore,
      chatMessageFileGcService: deps.chatMessageFileGcService
    },
      editor: createEditorService({
        config: deps.config,
        configManager: deps.configManager,
        whitelistStore: deps.whitelistStore,
        scheduler: deps.scheduler
      }),
      dataBrowser: createDataBrowserService({
        config: deps.config
      }),
      localFileAdmin: createLocalFileAdminService({
        localFileService: deps.localFileService,
        chatFileStore: deps.chatFileStore,
        ...(deps.contentSafetyStore ? { contentSafetyStore: deps.contentSafetyStore } : {})
      }),
      operations: {
        requestStore: deps.requestStore,
        scheduledJobStore: deps.scheduledJobStore
      },
      workspace: {
        localFileService: deps.localFileService,
        chatFileStore: deps.chatFileStore,
        oneBotClient: deps.oneBotClient
      }
    },
    messagingRoutes: {
      config: deps.config,
      oneBotClient: deps.oneBotClient,
      sessionManager: deps.sessionManager,
      handleWebIncomingMessage: deps.handleWebIncomingMessage,
      chatFileStore: deps.chatFileStore
    },
    uploadRoutes: {
      chatFileStore: deps.chatFileStore,
      logger: deps.logger
    },
    shellRoutes: {
      shellRuntime: deps.shellRuntime
    },
    browserRoutes: {
      browserService: deps.browserService
    }
  };
}

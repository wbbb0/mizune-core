import type { Logger } from "pino";
import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { AppConfig } from "#config/config.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { PersonaStore } from "#persona/personaStore.ts";
import type { GlobalMemoryStore } from "#memory/memoryStore.ts";
import type { RequestStore } from "#requests/requestStore.ts";
import type { ScheduledJobStore } from "#runtime/scheduler/jobStore.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { ShellRuntime } from "#services/shell/runtime.ts";
import type { SessionPersistence } from "#conversation/session/sessionPersistence.ts";
import type { ConfigManager } from "#config/configManager.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { GenerationWebOutputCollector } from "#app/generation/generationTypes.ts";
import type { BrowserService } from "#services/web/browser/browserService.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { ChatMessageFileGcService } from "#services/workspace/chatMessageFileGcService.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { LocalFileService } from "#services/workspace/localFileService.ts";
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

export interface InternalApiDeps {
  config: AppConfig;
  logger: Logger;
  oneBotClient: OneBotClient;
  sessionManager: SessionManager;
  personaStore: PersonaStore;
  globalMemoryStore: GlobalMemoryStore;
  userStore: UserStore;
  whitelistStore: WhitelistStore;
  requestStore: RequestStore;
  scheduledJobStore: ScheduledJobStore;
  scheduler: Scheduler;
  shellRuntime: ShellRuntime;
  configManager: ConfigManager;
  sessionPersistence: SessionPersistence;
  persistSession: (sessionId: string, reason: string) => void;
  flushSession: (
    sessionId: string,
    options?: {
      skipReplyGate?: boolean;
      delivery?: "onebot" | "web";
      webOutputCollector?: GenerationWebOutputCollector;
    }
  ) => void;
  handleWebIncomingMessage: (
    incomingMessage: ParsedIncomingMessage,
    options: {
      webOutputCollector: GenerationWebOutputCollector;
      sessionId?: string;
    }
  ) => Promise<void>;
  browserService: BrowserService;
  localFileService: LocalFileService;
  chatFileStore: ChatFileStore;
  chatMessageFileGcService: ChatMessageFileGcService;
  mediaVisionService: MediaVisionService;
  mediaCaptionService: MediaCaptionService;
}

export interface InternalApiServices {
  config: Pick<InternalApiDeps, "config" | "whitelistStore" | "sessionManager" | "sessionPersistence" | "personaStore" | "globalMemoryStore" | "userStore" | "chatMessageFileGcService">;
  editor: EditorService;
  dataBrowser: DataBrowserService;
  localFileAdmin: LocalFileAdminService;
  operations: Pick<InternalApiDeps, "requestStore" | "scheduledJobStore">;
  messaging: Pick<InternalApiDeps, "config" | "oneBotClient" | "sessionManager" | "handleWebIncomingMessage" | "chatFileStore">;
  uploads: Pick<InternalApiDeps, "chatFileStore">;
  shell: Pick<InternalApiDeps, "shellRuntime">;
  browser: Pick<InternalApiDeps, "browserService">;
  workspace: Pick<InternalApiDeps, "localFileService" | "chatFileStore" | "oneBotClient">;
}

export function createInternalApiServices(deps: InternalApiDeps): InternalApiServices {
  return {
    config: {
      config: deps.config,
      whitelistStore: deps.whitelistStore,
      sessionManager: deps.sessionManager,
      sessionPersistence: deps.sessionPersistence,
      personaStore: deps.personaStore,
      globalMemoryStore: deps.globalMemoryStore,
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
      config: deps.config,
      localFileService: deps.localFileService,
      chatFileStore: deps.chatFileStore
    }),
    operations: {
      requestStore: deps.requestStore,
      scheduledJobStore: deps.scheduledJobStore
    },
    messaging: {
      config: deps.config,
      oneBotClient: deps.oneBotClient,
      sessionManager: deps.sessionManager,
      handleWebIncomingMessage: deps.handleWebIncomingMessage,
      chatFileStore: deps.chatFileStore
    },
    uploads: {
      chatFileStore: deps.chatFileStore
    },
    shell: {
      shellRuntime: deps.shellRuntime
    },
    browser: {
      browserService: deps.browserService
    },
    workspace: {
      localFileService: deps.localFileService,
      chatFileStore: deps.chatFileStore,
      oneBotClient: deps.oneBotClient
    }
  };
}

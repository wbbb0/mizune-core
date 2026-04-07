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
import type { GenerationWebOutputCollector } from "#app/generation/generationExecutor.ts";
import type { BrowserService } from "#services/web/browser/browserService.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { WorkspaceService } from "#services/workspace/workspaceService.ts";
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
  createWorkspaceAdminService,
  type WorkspaceAdminService
} from "./application/workspaceAdminService.ts";

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
  workspaceService: WorkspaceService;
  mediaWorkspace: MediaWorkspace;
  mediaVisionService: MediaVisionService;
  mediaCaptionService: MediaCaptionService;
}

export interface InternalApiServices {
  config: Pick<InternalApiDeps, "config" | "whitelistStore" | "sessionManager" | "sessionPersistence" | "personaStore" | "globalMemoryStore" | "userStore">;
  editor: EditorService;
  dataBrowser: DataBrowserService;
  workspaceAdmin: WorkspaceAdminService;
  operations: Pick<InternalApiDeps, "requestStore" | "scheduledJobStore">;
  messaging: Pick<InternalApiDeps, "config" | "oneBotClient" | "sessionManager" | "handleWebIncomingMessage" | "mediaWorkspace">;
  uploads: Pick<InternalApiDeps, "mediaWorkspace">;
  shell: Pick<InternalApiDeps, "shellRuntime">;
  browser: Pick<InternalApiDeps, "browserService">;
  workspace: Pick<InternalApiDeps, "workspaceService" | "mediaWorkspace" | "oneBotClient">;
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
      userStore: deps.userStore
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
    workspaceAdmin: createWorkspaceAdminService({
      workspaceService: deps.workspaceService,
      mediaWorkspace: deps.mediaWorkspace
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
      mediaWorkspace: deps.mediaWorkspace
    },
    uploads: {
      mediaWorkspace: deps.mediaWorkspace
    },
    shell: {
      shellRuntime: deps.shellRuntime
    },
    browser: {
      browserService: deps.browserService
    },
    workspace: {
      workspaceService: deps.workspaceService,
      mediaWorkspace: deps.mediaWorkspace,
      oneBotClient: deps.oneBotClient
    }
  };
}

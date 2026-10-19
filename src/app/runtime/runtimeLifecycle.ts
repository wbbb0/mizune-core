import type { TemporaryWorkspaceService } from "#services/workspace/temporaryWorkspaceService.ts";
import type { ConfigManager } from "#config/configManager.ts";
import type { Logger } from "pino";
import { startInternalApi } from "#internalApi/server.ts";
import { Scheduler } from "#runtime/scheduler/scheduler.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { BrowserService } from "#services/web/browser/browserService.ts";
import type { AppConfig } from "#config/config.ts";
import type { OneBotMessageEvent, OneBotRequestEvent } from "#services/onebot/types.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { LocalFileService } from "#services/workspace/localFileService.ts";
import type { ComfyTaskRunner } from "#comfy/taskRunner.ts";
import type { ComfyTemplateCatalogService } from "#comfy/templateCatalogService.ts";
import type { InternalApiServices } from "#internalApi/types.ts";
import type { ContextMaintenanceService } from "#context/contextMaintenanceService.ts";
import type { ContextExtractionQueue } from "#context/contextExtractionQueue.ts";
import type { DownloadRuntime } from "#services/workspace/downloadRuntime.ts";

export interface InternalApiController {
  close: () => Promise<void>;
}

export async function startSchedulerIfEnabled(
  config: AppConfig,
  scheduler: Scheduler,
  logger: Logger
): Promise<boolean> {
  if (!config.scheduler.enabled) {
    return false;
  }
  await scheduler.start();
  logger.info("scheduler_started");
  return true;
}

export async function startInternalApiIfEnabled(input: {
  config: AppConfig;
  logger: Logger;
  services: InternalApiServices;
}): Promise<InternalApiController | null> {
  return input.config.internalApi.enabled
    ? startInternalApi(input)
    : null;
}

export function subscribeRuntimeReload(input: {
  configManager: ConfigManager;
  config: AppConfig;
  logger: Logger;
  oneBotClient: OneBotClient;
  browserService: BrowserService;
  localFileService: LocalFileService;
  chatFileStore: ChatFileStore;
  assetLifecycleService: import("#data/assets/assetLifecycleService.ts").AssetLifecycleService;
  searchService: { reloadConfig: () => void };
  scheduler: Scheduler;
  comfyTemplateCatalog: ComfyTemplateCatalogService;
  comfyTaskRunner: ComfyTaskRunner;
  contextExtractionQueue: Pick<ContextExtractionQueue, "reloadConfig">;
  isSchedulerStarted: () => boolean;
  setSchedulerStarted: (value: boolean) => void;
  getInternalApi: () => InternalApiController | null;
  setInternalApi: (value: InternalApiController | null) => void;
  services: InternalApiServices;
}): void {
  input.configManager.subscribe(() => input.searchService.reloadConfig());
  input.configManager.subscribe(() => input.browserService.reloadConfig());
  input.configManager.subscribe(({ previousConfig }) => input.oneBotClient.reloadConfig(previousConfig));
  input.configManager.subscribe(() => input.comfyTemplateCatalog.reload());
  input.configManager.subscribe(() => input.comfyTaskRunner.reloadConfig());
  input.configManager.subscribe(() => input.contextExtractionQueue.reloadConfig());
  input.configManager.subscribe(async ({ currentConfig }) => {
    if (currentConfig.scheduler.enabled) {
      if (!input.isSchedulerStarted()) {
        await input.scheduler.start();
        input.setSchedulerStarted(true);
      }
    } else {
      // start() may fail after installing some timers, before started becomes true.
      await input.scheduler.stop();
      input.setSchedulerStarted(false);
    }
  });
  input.configManager.subscribe(async ({ previousConfig, currentConfig }) => {
    const internalApiNeedsRestart =
      JSON.stringify(previousConfig.internalApi) !== JSON.stringify(currentConfig.internalApi)
      || (currentConfig.internalApi.enabled && input.getInternalApi() == null);
    if (!internalApiNeedsRestart) {
      return;
    }

    const currentInternalApi = input.getInternalApi();
    if (currentInternalApi != null) {
      await currentInternalApi.close();
      input.setInternalApi(null);
    }
    if (!currentConfig.internalApi.enabled) {
      return;
    }

    input.setInternalApi(await startInternalApi({
      config: input.config,
      logger: input.logger,
      services: input.services
    }));
  });
}

export async function shutdownRuntime(input: {
  configManager: ConfigManager;
  oneBotClient: OneBotClient;
  onMessage: (event: OneBotMessageEvent) => void;
  onRequest: (event: OneBotRequestEvent) => void;
  internalApi: InternalApiController | null;
  browserService: BrowserService;
  downloadRuntime: DownloadRuntime;
  temporaryWorkspaceService: TemporaryWorkspaceService;
  schedulerStarted: boolean;
  scheduler: Scheduler;
  contextMaintenanceService: ContextMaintenanceService;
  contextExtractionQueue: ContextExtractionQueue;
  comfyTaskRunner: ComfyTaskRunner;
  singleInstanceLock: { release: () => Promise<void> };
  logger: Logger & { flush?: () => void | Promise<void> };
}): Promise<void> {
  input.configManager.stop();
  try {
    input.oneBotClient.off("message", input.onMessage);
    input.oneBotClient.off("request", input.onRequest);

    if (input.internalApi != null) {
      await input.internalApi.close();
    }
    if (input.schedulerStarted) {
      await input.scheduler.stop();
    }
    await input.browserService.shutdown();
    await input.downloadRuntime.close();
    await input.temporaryWorkspaceService.shutdown();
    input.contextMaintenanceService.stop();
    input.contextExtractionQueue.stop();
    await input.comfyTaskRunner.stop();
    await input.oneBotClient.stop();
    input.logger.info("application_stopped");
  } finally {
    await input.singleInstanceLock.release();
    await Promise.resolve(input.logger.flush?.());
  }
}

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
  chatMessageFileGcService: import("#services/workspace/chatMessageFileGcService.ts").ChatMessageFileGcService;
  searchService: { reloadConfig: () => void };
  scheduler: Scheduler;
  comfyTemplateCatalog: ComfyTemplateCatalogService;
  comfyTaskRunner: ComfyTaskRunner;
  isSchedulerStarted: () => boolean;
  setSchedulerStarted: (value: boolean) => void;
  getInternalApi: () => InternalApiController | null;
  setInternalApi: (value: InternalApiController | null) => void;
  services: InternalApiServices;
}): void {
  input.configManager.subscribe(async ({ previousConfig, currentConfig }) => {
    input.searchService.reloadConfig();
    await input.browserService.reloadConfig();
    await input.oneBotClient.reloadConfig(previousConfig);
    await input.comfyTemplateCatalog.reload();
    await input.comfyTaskRunner.reloadConfig();

    const schedulerEnabledChanged = previousConfig.scheduler.enabled !== currentConfig.scheduler.enabled;
    if (schedulerEnabledChanged) {
      if (currentConfig.scheduler.enabled) {
        await input.scheduler.start();
        input.setSchedulerStarted(true);
        input.logger.info("scheduler_started_after_config_reload");
      } else if (input.isSchedulerStarted()) {
        await input.scheduler.stop();
        input.setSchedulerStarted(false);
        input.logger.info("scheduler_stopped_after_config_reload");
      }
    }

    const internalApiNeedsRestart =
      previousConfig.internalApi.enabled !== currentConfig.internalApi.enabled
      || previousConfig.internalApi.port !== currentConfig.internalApi.port;
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
  schedulerStarted: boolean;
  scheduler: Scheduler;
  contextMaintenanceService: ContextMaintenanceService;
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
    input.contextMaintenanceService.stop();
    await input.comfyTaskRunner.stop();
    await input.oneBotClient.stop();
    input.logger.info("application_stopped");
  } finally {
    await input.singleInstanceLock.release();
    await Promise.resolve(input.logger.flush?.());
  }
}

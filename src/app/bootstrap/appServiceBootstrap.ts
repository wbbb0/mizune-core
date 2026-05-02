import { createBootstrapConfigManager, createBootstrapServices, initializeBootstrapState } from "./bootstrapServices.ts";
import { createBootstrapRuntimeContext } from "./bootstrapRuntimeContext.ts";
import type { AppServiceBootstrap } from "./bootstrapTypes.ts";
import type { AppConfig } from "#config/config.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";

export type { AppServiceBootstrap } from "./bootstrapTypes.ts";

export interface AppServiceBootstrapOptions {
  transformConfig?: (config: AppConfig) => AppConfig;
  oneBotClient?: OneBotClient;
}

// Builds and initializes the shared service graph used by the application runtime.
export async function createAppServiceBootstrap(options: AppServiceBootstrapOptions = {}): Promise<AppServiceBootstrap> {
  const context = await createBootstrapRuntimeContext({
    ...(options.transformConfig ? { transformConfig: options.transformConfig } : {})
  });
  const services = createBootstrapServices(context, {
    ...(options.oneBotClient ? { oneBotClient: options.oneBotClient } : {})
  });
  await initializeBootstrapState({
    config: context.config,
    logger: context.logger,
    dataDir: context.dataDir,
    ...services
  });
  const configManager = createBootstrapConfigManager(context);

  return {
    config: context.config,
    logger: context.logger,
    dataDir: context.dataDir,
    ...services,
    configManager,
    singleInstanceLock: context.singleInstanceLock
  };
}

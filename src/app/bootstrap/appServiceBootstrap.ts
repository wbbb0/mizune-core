import { createBootstrapConfigManager, createBootstrapServices, initializeBootstrapState } from "./bootstrapServices.ts";
import { createBootstrapRuntimeContext } from "./bootstrapRuntimeContext.ts";
import type { AppServiceBootstrap } from "./bootstrapTypes.ts";

export type { AppServiceBootstrap } from "./bootstrapTypes.ts";

// Builds and initializes the shared service graph used by the application runtime.
export async function createAppServiceBootstrap(): Promise<AppServiceBootstrap> {
  const context = await createBootstrapRuntimeContext();
  const services = createBootstrapServices(context);
  await initializeBootstrapState({
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

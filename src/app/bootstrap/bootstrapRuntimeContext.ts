import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "#config/config.ts";
import type { AppConfig } from "#config/config.ts";
import { createLogger } from "../../logger.ts";
import { SingleInstanceLock } from "#runtime/singleInstanceLock.ts";
import type { BootstrapRuntimeContext } from "./bootstrapTypes.ts";
import { RecentErrorCapture } from "#runtime/recentErrorStore.ts";

export async function createBootstrapRuntimeContext(options: {
  transformConfig?: (config: AppConfig) => AppConfig;
} = {}): Promise<BootstrapRuntimeContext> {
  const loadedConfig = loadConfig();
  const config = options.transformConfig ? options.transformConfig(loadedConfig) : loadedConfig;
  const recentErrorCapture = new RecentErrorCapture();
  const logger = createLogger(config, {
    recentErrorSink: (input) => recentErrorCapture.record(input)
  });
  const dataDir = resolve(process.cwd(), config.dataDir);
  await mkdir(dataDir, { recursive: true });
  const singleInstanceLock = await SingleInstanceLock.acquire(dataDir, config);

  return {
    config,
    logger,
    dataDir,
    recentErrorCapture,
    singleInstanceLock
  };
}

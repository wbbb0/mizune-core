import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "#config/config.ts";
import { createLogger } from "../../logger.ts";
import { SingleInstanceLock } from "#runtime/singleInstanceLock.ts";
import type { BootstrapRuntimeContext } from "./bootstrapTypes.ts";

export async function createBootstrapRuntimeContext(): Promise<BootstrapRuntimeContext> {
  const config = loadConfig();
  const logger = createLogger(config);
  const dataDir = resolve(process.cwd(), config.dataDir);
  await mkdir(dataDir, { recursive: true });
  const singleInstanceLock = await SingleInstanceLock.acquire(dataDir, config);

  return {
    config,
    logger,
    dataDir,
    singleInstanceLock
  };
}

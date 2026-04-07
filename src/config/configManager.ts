import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { loadConfig, toConfigSummary } from "#config/config.ts";

const CONFIG_POLL_INTERVAL_MS = 1000;

type ConfigReloadListener = (params: {
  previousConfig: AppConfig;
  currentConfig: AppConfig;
}) => Promise<void> | void;

export class ConfigManager {
  private readonly listeners = new Set<ConfigReloadListener>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private lastFileStates = new Map<string, number | null>();
  private reloading = false;

  constructor(
    private readonly config: AppConfig,
    logger: Logger,
    env: NodeJS.ProcessEnv = process.env
  ) {
    this.logger = logger;
    this.env = { ...env };
    this.captureCurrentFileStates();
  }

  async start(): Promise<void> {
    if (this.timer != null) {
      return;
    }
    this.lastFileStates = await this.collectFileStates();
    this.timer = setInterval(() => {
      void this.checkForUpdates();
    }, CONFIG_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  subscribe(listener: ConfigReloadListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async checkForUpdates(): Promise<boolean> {
    if (this.reloading) {
      return false;
    }

    const nextStates = await this.collectFileStates();
    const changed = statesDiffer(this.lastFileStates, nextStates);
    if (!changed) {
      return false;
    }

    this.reloading = true;
    try {
      const previousConfig = structuredClone(this.config);
      const reloadedConfig = loadConfig(this.env);
      syncPlainObject(this.config as unknown as Record<string, unknown>, reloadedConfig as unknown as Record<string, unknown>);
      this.lastFileStates = nextStates;

      this.logger.info(
        {
          startup: toConfigSummary(this.config)
        },
        "config_reloaded"
      );

      for (const listener of this.listeners) {
        await listener({
          previousConfig,
          currentConfig: this.config
        });
      }
      return true;
    } catch (error: unknown) {
      this.logger.error(
        {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        },
        "config_reload_failed"
      );
      return false;
    } finally {
      this.reloading = false;
    }
  }

  private captureCurrentFileStates(): void {
    const fileStates = new Map<string, number | null>();
    for (const filePath of [
      this.config.configRuntime.globalConfigPath,
      this.config.configRuntime.llmProviderCatalogPath,
      this.config.configRuntime.llmModelCatalogPath,
      ...(this.config.configRuntime.instanceConfigPath ? [this.config.configRuntime.instanceConfigPath] : []),
      resolve(this.config.configRuntime.configDir, "templates")
    ]) {
      fileStates.set(filePath, null);
    }
    this.lastFileStates = fileStates;
  }

  private async collectFileStates(): Promise<Map<string, number | null>> {
    const watchedPaths = await getWatchedConfigPaths(this.config);
    const entries = await Promise.all(
      watchedPaths.map(async (filePath) => [filePath, await getFileMtimeMs(filePath)] as const)
    );
    return new Map(entries);
  }
}

async function getWatchedConfigPaths(config: AppConfig): Promise<string[]> {
  const basePaths = [
    config.configRuntime.globalConfigPath,
    config.configRuntime.llmProviderCatalogPath,
    config.configRuntime.llmModelCatalogPath,
    ...(config.configRuntime.instanceConfigPath ? [config.configRuntime.instanceConfigPath] : [])
  ];

  const templateRoot = resolve(config.configRuntime.configDir, "templates");
  const templatePaths = await collectDirectoryFilePaths(templateRoot);
  return [
    ...basePaths,
    templateRoot,
    ...templatePaths
  ];
}

async function getFileMtimeMs(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function collectDirectoryFilePaths(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const entryPath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return [entryPath, ...(await collectDirectoryFilePaths(entryPath))];
      }
      return [entryPath];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

function statesDiffer(current: Map<string, number | null>, next: Map<string, number | null>): boolean {
  if (current.size !== next.size) {
    return true;
  }
  for (const [filePath, nextMtime] of next.entries()) {
    if (!current.has(filePath) || current.get(filePath) !== nextMtime) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function syncPlainObject(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key];
    }
  }

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    if (Array.isArray(sourceValue)) {
      target[key] = structuredClone(sourceValue);
      continue;
    }
    if (isPlainObject(sourceValue)) {
      const nextTarget = isPlainObject(targetValue) ? targetValue : {};
      target[key] = nextTarget;
      syncPlainObject(nextTarget, sourceValue);
      continue;
    }
    target[key] = sourceValue;
  }
}

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { loadConfig, toConfigSummary } from "#config/config.ts";

const CONFIG_POLL_INTERVAL_MS = 1000;
type FileState = string | null;

type ConfigReloadListener = (params: {
  previousConfig: AppConfig;
  currentConfig: AppConfig;
}) => Promise<void> | void;

export class ConfigManager {
  private readonly listeners = new Set<ConfigReloadListener>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private lastFileStates = new Map<string, FileState>();
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
    const changedPaths = getChangedPaths(this.lastFileStates, nextStates);
    if (changedPaths.length === 0) {
      return false;
    }

    this.reloading = true;
    try {
      const previousConfig = structuredClone(this.config);
      const reloadedConfig = loadConfig(this.env);
      syncPlainObject(this.config as unknown as Record<string, unknown>, reloadedConfig as unknown as Record<string, unknown>);
      this.lastFileStates = await this.collectFileStates();

      this.logger.info(
        {
          changedPaths,
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
          changedPaths,
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
    const fileStates = new Map<string, FileState>();
    for (const filePath of getWatchedConfigRootPaths(this.config)) {
      fileStates.set(filePath, null);
    }
    this.lastFileStates = fileStates;
  }

  private async collectFileStates(): Promise<Map<string, FileState>> {
    const watchedPaths = await getWatchedConfigPaths(this.config);
    const entries = await Promise.all(
      watchedPaths.map(async (filePath) => [filePath, await getFileState(filePath)] as const)
    );
    return new Map(entries);
  }
}

async function getWatchedConfigPaths(config: AppConfig): Promise<string[]> {
  const basePaths = getWatchedConfigRootPaths(config);
  const templateRoot = getComfyTemplateRootPath(config);
  const templatePaths = await collectDirectoryFilePaths(templateRoot);
  return [
    ...basePaths,
    ...templatePaths
  ];
}

function getWatchedConfigRootPaths(config: AppConfig): string[] {
  return dedupePaths([
    ...config.configRuntime.loadedConfigPaths,
    config.configRuntime.globalConfigPath,
    config.configRuntime.llmProviderCatalogPath,
    config.configRuntime.llmModelCatalogPath,
    config.configRuntime.llmRoutingPresetCatalogPath,
    config.configRuntime.instanceConfigPath,
    getComfyTemplateRootPath(config)
  ]);
}

function getComfyTemplateRootPath(config: AppConfig): string {
  return resolve(config.configRuntime.configDir, config.comfy.templateRoot);
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

async function getFileState(filePath: string): Promise<FileState> {
  try {
    const fileStat = await stat(filePath);
    return [
      fileStat.isDirectory() ? "dir" : "file",
      fileStat.mtimeMs,
      fileStat.size
    ].join(":");
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

function getChangedPaths(current: Map<string, FileState>, next: Map<string, FileState>): string[] {
  const changedPaths: string[] = [];
  for (const [filePath, nextMtime] of next.entries()) {
    if (!current.has(filePath) || current.get(filePath) !== nextMtime) {
      changedPaths.push(filePath);
    }
  }
  for (const filePath of current.keys()) {
    if (!next.has(filePath)) {
      changedPaths.push(filePath);
    }
  }
  return changedPaths;
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

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";
import type { BaseSchema } from "./schema/base.ts";
import { dumpConfigString, parseConfig, readStructuredFileRaw } from "./schema/file.ts";
import { cloneDefault } from "./schema/helpers.ts";
import type { ConfigFormat, Infer } from "./schema/types.ts";

export class FileSchemaStore<TSchema extends BaseSchema<any>> {
  private cachedValue: Infer<TSchema> | null = null;
  private cachedMtimeMs: number | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      filePath: string;
      schema: TSchema;
      logger: Logger;
      loadErrorEvent: string;
      atomicWrite?: boolean;
      format?: ConfigFormat;
    }
  ) {}

  async initDir(): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true });
  }

  async read(): Promise<Infer<TSchema> | null> {
    try {
      const fileStat = await stat(this.options.filePath);
      if (this.cachedValue && this.cachedMtimeMs === fileStat.mtimeMs) {
        return this.cachedValue;
      }

      const raw = await readStructuredFileRaw(this.options.filePath);
      const parsed = parseConfig(this.options.schema, raw);
      this.cachedValue = parsed;
      this.cachedMtimeMs = fileStat.mtimeMs;
      return parsed;
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return null;
      }
      this.options.logger.warn({ error, filePath: this.options.filePath }, this.options.loadErrorEvent);
      throw error;
    }
  }

  async readOrCreate(factory: () => Infer<TSchema> | Promise<Infer<TSchema>>): Promise<Infer<TSchema>> {
    return this.withWriteLock(async () => {
      try {
        const current = await this.read();
        if (current != null) {
          return current;
        }
      } catch {
        // Fall through and regenerate the file from the provided factory.
      }
      const initial = await factory();
      return this.writeUnlocked(initial);
    });
  }

  async readOrDefault(fallback: Infer<TSchema>): Promise<Infer<TSchema>> {
    return this.readOrCreate(() => cloneDefault(fallback));
  }

  async write(value: Infer<TSchema>): Promise<Infer<TSchema>> {
    return this.withWriteLock(() => this.writeUnlocked(value));
  }

  private async writeUnlocked(value: Infer<TSchema>): Promise<Infer<TSchema>> {
    const validated = parseConfig(this.options.schema, value, {
      cloneInput: true
    });
    await this.initDir();
    const content = dumpConfigString(validated, {
      format: this.options.format ?? "json",
      prettyJsonSpaces: 2
    });
    if (this.options.atomicWrite) {
      const tempPath = `${this.options.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, this.options.filePath);
    } else {
      await writeFile(this.options.filePath, content, "utf8");
    }
    const fileStat = await stat(this.options.filePath);
    this.cachedValue = validated;
    this.cachedMtimeMs = fileStat.mtimeMs;
    return validated;
  }

  async update(
    updater: (current: Infer<TSchema> | null) => Infer<TSchema> | Promise<Infer<TSchema>>
  ): Promise<Infer<TSchema>> {
    return this.withWriteLock(async () => {
      const current = await this.read();
      const next = await updater(current);
      return this.writeUnlocked(next);
    });
  }

  async updateExisting(
    updater: (current: Infer<TSchema>) => Infer<TSchema> | Promise<Infer<TSchema>>,
    factory: () => Infer<TSchema> | Promise<Infer<TSchema>>
  ): Promise<Infer<TSchema>> {
    return this.withWriteLock(async () => {
      let current: Infer<TSchema>;
      try {
        const existing = await this.read();
        current = existing ?? (await factory());
      } catch {
        current = await factory();
      }
      const next = await updater(current);
      return this.writeUnlocked(next);
    });
  }

  async readFileText(): Promise<string | null> {
    try {
      return await readFile(this.options.filePath, "utf8");
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.writeChain = chain;
    try {
      await previous.catch(() => undefined);
      return await operation();
    } finally {
      release?.();
      if (this.writeChain === chain) {
        this.writeChain = Promise.resolve();
      }
    }
  }
}

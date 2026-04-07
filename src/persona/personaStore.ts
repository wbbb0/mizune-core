import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import {
  createEmptyPersona,
  normalizeStoredPersona,
  personaSchema,
  type Persona
} from "./personaSchema.ts";

export class PersonaStore {
  private readonly filePath: string;
  private readonly store: FileSchemaStore<typeof personaSchema>;

  constructor(
    dataDir: string,
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "persona.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: personaSchema,
      logger,
      loadErrorEvent: "persona_reset_to_empty"
    });
  }

  async init(): Promise<void> {
    await this.get();
  }

  async get(): Promise<Persona> {
    try {
      const normalized = normalizeStoredPersona(await this.store.read());
      if (!normalized) {
        const resetPersona = createEmptyPersona();
        await this.write(resetPersona);
        this.logger.warn("persona_reset_to_empty");
        return resetPersona;
      }
      return normalized;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        const initialPersona = createEmptyPersona();
        await this.write(initialPersona);
        this.logger.info("persona_initialized_for_setup");
        return initialPersona;
      }
      const resetPersona = createEmptyPersona();
      await this.write(resetPersona);
      this.logger.warn("persona_reset_to_empty");
      return resetPersona;
    }
  }

  async write(persona: Persona): Promise<void> {
    const validated = personaSchema.parse(persona);
    await this.createBackupIfNeeded();
    await this.store.write(validated);
  }

  async patch(patch: Partial<Persona>): Promise<Persona> {
    const current = await this.get();
    const next = personaSchema.parse({
      ...current,
      ...patch
    });
    await this.write(next);
    this.logger.info({ patch }, "persona_updated");
    return next;
  }

  private async createBackupIfNeeded(): Promise<void> {
    try {
      await stat(this.filePath);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }
      throw error;
    }

    await rotateBackup({
      sourceFilePath: this.filePath,
      limit: this.config.backup.profileRotateLimit,
      logger: this.logger
    });
  }
}

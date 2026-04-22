import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import {
  createEmptyGlobalProfileReadiness,
  globalProfileReadinessSchema,
  type GlobalProfileReadiness,
  type GlobalProfileReadinessStatus
} from "./globalProfileReadinessSchema.ts";

export class GlobalProfileReadinessStore {
  private readonly store: FileSchemaStore<typeof globalProfileReadinessSchema>;

  constructor(
    dataDir: string,
    private readonly _config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "global-profile-readiness.json"),
      schema: globalProfileReadinessSchema,
      logger,
      loadErrorEvent: "global_profile_readiness_reset_to_empty"
    });
  }

  async init(): Promise<void> {
    await this.get();
  }

  createEmpty(): GlobalProfileReadiness {
    return createEmptyGlobalProfileReadiness();
  }

  async get(): Promise<GlobalProfileReadiness> {
    try {
      const current = await this.store.read();
      if (current) {
        return current;
      }
    } catch (error: unknown) {
      this.logger.warn({ error }, "global_profile_readiness_reset_to_empty");
    }
    const initial = this.createEmpty();
    await this.write(initial);
    return initial;
  }

  async write(value: GlobalProfileReadiness): Promise<GlobalProfileReadiness> {
    const next = globalProfileReadinessSchema.parse(value);
    return this.store.write(next);
  }

  async patch(patch: Partial<Omit<GlobalProfileReadiness, "updatedAt">>): Promise<GlobalProfileReadiness> {
    return this.write({
      ...(await this.get()),
      ...patch,
      updatedAt: Date.now()
    });
  }

  async setPersonaReadiness(persona: GlobalProfileReadinessStatus): Promise<GlobalProfileReadiness> {
    return this.patch({ persona });
  }

  async setRpReadiness(rp: GlobalProfileReadinessStatus): Promise<GlobalProfileReadiness> {
    return this.patch({ rp });
  }

  async setScenarioReadiness(scenario: GlobalProfileReadinessStatus): Promise<GlobalProfileReadiness> {
    return this.patch({ scenario });
  }

  async isPersonaReady(): Promise<boolean> {
    return (await this.get()).persona === "ready";
  }

  async isRpReady(): Promise<boolean> {
    return (await this.get()).rp === "ready";
  }

  async isScenarioReady(): Promise<boolean> {
    return (await this.get()).scenario === "ready";
  }
}

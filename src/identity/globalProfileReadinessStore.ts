import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import {
  createEmptyGlobalProfileReadiness,
  globalProfileReadinessSchema,
  type GlobalProfileReadiness,
  type GlobalProfileReadinessStatus
} from "./globalProfileReadinessSchema.ts";

export class GlobalProfileReadinessStore {
  constructor(
    dataDir: string,
    _config: Pick<AppConfig, "backup">,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
    await this.get();
  }

  createEmpty(): GlobalProfileReadiness {
    return createEmptyGlobalProfileReadiness();
  }

  async get(): Promise<GlobalProfileReadiness> {
    await this.stateDatabase.init();
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        persona,
        rp,
        updated_at_ms AS updatedAt
      FROM global_profile_readiness
      WHERE id = 'global'
    `).get() as GlobalProfileReadiness | undefined;
    if (row) {
      return globalProfileReadinessSchema.parse(row);
    }
    const initial = this.createEmpty();
    await this.write(initial);
    this.logger.info("global_profile_readiness_initialized_for_setup");
    return initial;
  }

  async write(value: GlobalProfileReadiness): Promise<GlobalProfileReadiness> {
    await this.stateDatabase.init();
    const next = globalProfileReadinessSchema.parse(value);
    this.stateDatabase.getDb().prepare(`
      INSERT INTO global_profile_readiness (
        id,
        persona,
        rp,
        updated_at_ms
      )
      VALUES (
        'global',
        @persona,
        @rp,
        @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        persona = excluded.persona,
        rp = excluded.rp,
        updated_at_ms = excluded.updated_at_ms
    `).run(next);
    return next;
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

  async isPersonaReady(): Promise<boolean> {
    return (await this.get()).persona === "ready";
  }

  async isRpReady(): Promise<boolean> {
    return (await this.get()).rp === "ready";
  }
}

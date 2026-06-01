import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import {
  createEmptyRpProfile,
  describeMissingRpProfileFields,
  editableRpProfileFieldNames,
  isRpProfileComplete,
  rpProfileFieldLabels,
  rpProfileSchema,
  type RpProfile
} from "./profileSchema.ts";

export class RpProfileStore {
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

  createEmpty(): RpProfile {
    return createEmptyRpProfile();
  }

  isComplete(profile: RpProfile): boolean {
    return isRpProfileComplete(profile);
  }

  describeMissingFields(profile: RpProfile): Array<{ key: typeof editableRpProfileFieldNames[number]; label: string }> {
    return describeMissingRpProfileFields(profile).map((key) => ({
      key,
      label: rpProfileFieldLabels[key]
    }));
  }

  async get(): Promise<RpProfile> {
    await this.stateDatabase.init();
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        identity,
        background,
        continuity_facts AS continuityFacts,
        boundaries
      FROM rp_profile
      WHERE id = 'global'
    `).get() as RpProfile | undefined;
    if (row) {
      return rpProfileSchema.parse(row);
    }
    const initial = createEmptyRpProfile();
    await this.write(initial);
    this.logger.info("rp_profile_initialized_for_setup");
    return initial;
  }

  async write(profile: RpProfile): Promise<void> {
    await this.stateDatabase.init();
    const validated = rpProfileSchema.parse(profile);
    this.stateDatabase.getDb().prepare(`
      INSERT INTO rp_profile (
        id,
        identity,
        background,
        continuity_facts,
        boundaries,
        updated_at_ms
      )
      VALUES (
        'global',
        @identity,
        @background,
        @continuityFacts,
        @boundaries,
        @updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        identity = excluded.identity,
        background = excluded.background,
        continuity_facts = excluded.continuity_facts,
        boundaries = excluded.boundaries,
        updated_at_ms = excluded.updated_at_ms
    `).run({
      ...validated,
      updatedAtMs: Date.now()
    });
  }

  async patch(patch: Partial<RpProfile>): Promise<RpProfile> {
    const current = await this.get();
    const next = rpProfileSchema.parse({
      ...current,
      ...patch
    });
    await this.write(next);
    return next;
  }
}

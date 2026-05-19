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
        self_positioning AS selfPositioning,
        social_role AS socialRole,
        life_context AS lifeContext,
        physical_presence AS physicalPresence,
        reality_contract AS realityContract,
        continuity_facts AS continuityFacts,
        hard_limits AS hardLimits
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
        self_positioning,
        social_role,
        life_context,
        physical_presence,
        reality_contract,
        continuity_facts,
        hard_limits,
        updated_at_ms
      )
      VALUES (
        'global',
        @selfPositioning,
        @socialRole,
        @lifeContext,
        @physicalPresence,
        @realityContract,
        @continuityFacts,
        @hardLimits,
        @updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        self_positioning = excluded.self_positioning,
        social_role = excluded.social_role,
        life_context = excluded.life_context,
        physical_presence = excluded.physical_presence,
        reality_contract = excluded.reality_contract,
        continuity_facts = excluded.continuity_facts,
        hard_limits = excluded.hard_limits,
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

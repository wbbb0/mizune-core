import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import {
  createEmptyScenarioProfile,
  describeMissingScenarioProfileFields,
  editableScenarioProfileFieldNames,
  isScenarioProfileComplete,
  scenarioProfileFieldLabels,
  scenarioProfileSchema,
  type ScenarioProfile
} from "./profileSchema.ts";

export class ScenarioProfileStore {
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

  createEmpty(): ScenarioProfile {
    return createEmptyScenarioProfile();
  }

  isComplete(profile: ScenarioProfile): boolean {
    return isScenarioProfileComplete(profile);
  }

  describeMissingFields(profile: ScenarioProfile): Array<{ key: typeof editableScenarioProfileFieldNames[number]; label: string }> {
    return describeMissingScenarioProfileFields(profile).map((key) => ({
      key,
      label: scenarioProfileFieldLabels[key]
    }));
  }

  async get(): Promise<ScenarioProfile> {
    await this.stateDatabase.init();
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        theme,
        host_style AS hostStyle,
        world_baseline AS worldBaseline,
        safety_or_taboo_rules AS safetyOrTabooRules,
        opening_pattern AS openingPattern
      FROM scenario_profile
      WHERE id = 'global'
    `).get() as ScenarioProfile | undefined;
    if (row) {
      return scenarioProfileSchema.parse(row);
    }
    const initial = createEmptyScenarioProfile();
    await this.write(initial);
    this.logger.info("scenario_profile_initialized_for_setup");
    return initial;
  }

  async write(profile: ScenarioProfile): Promise<void> {
    await this.stateDatabase.init();
    const validated = scenarioProfileSchema.parse(profile);
    this.stateDatabase.getDb().prepare(`
      INSERT INTO scenario_profile (
        id,
        theme,
        host_style,
        world_baseline,
        safety_or_taboo_rules,
        opening_pattern,
        updated_at_ms
      )
      VALUES (
        'global',
        @theme,
        @hostStyle,
        @worldBaseline,
        @safetyOrTabooRules,
        @openingPattern,
        @updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        theme = excluded.theme,
        host_style = excluded.host_style,
        world_baseline = excluded.world_baseline,
        safety_or_taboo_rules = excluded.safety_or_taboo_rules,
        opening_pattern = excluded.opening_pattern,
        updated_at_ms = excluded.updated_at_ms
    `).run({
      ...validated,
      updatedAtMs: Date.now()
    });
  }

  async patch(patch: Partial<ScenarioProfile>): Promise<ScenarioProfile> {
    const current = await this.get();
    const next = scenarioProfileSchema.parse({
      ...current,
      ...patch
    });
    await this.write(next);
    return next;
  }
}

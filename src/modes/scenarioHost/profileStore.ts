import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
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
  private readonly filePath: string;
  private readonly store: FileSchemaStore<typeof scenarioProfileSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "scenario-profile.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: scenarioProfileSchema,
      logger,
      loadErrorEvent: "scenario_profile_reset_to_empty"
    });
  }

  async init(): Promise<void> {
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
    try {
      const current = await this.store.read();
      if (current) {
        return current;
      }
    } catch (error: unknown) {
      this.logger.warn({ error }, "scenario_profile_reset_to_empty");
    }
    const initial = createEmptyScenarioProfile();
    await this.write(initial);
    return initial;
  }

  async write(profile: ScenarioProfile): Promise<void> {
    const validated = scenarioProfileSchema.parse(profile);
    await this.createBackupIfNeeded();
    await this.store.write(validated);
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

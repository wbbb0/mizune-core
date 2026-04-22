import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
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
  private readonly filePath: string;
  private readonly store: FileSchemaStore<typeof rpProfileSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "rp-profile.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: rpProfileSchema,
      logger,
      loadErrorEvent: "rp_profile_reset_to_empty"
    });
  }

  async init(): Promise<void> {
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
    try {
      const current = await this.store.read();
      if (current) {
        return current;
      }
    } catch (error: unknown) {
      this.logger.warn({ error }, "rp_profile_reset_to_empty");
    }
    const initial = createEmptyRpProfile();
    await this.write(initial);
    return initial;
  }

  async write(profile: RpProfile): Promise<void> {
    const validated = rpProfileSchema.parse(profile);
    await this.createBackupIfNeeded();
    await this.store.write(validated);
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

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import {
  createEmptyPersona,
  describeMissingPersonaFields,
  editablePersonaFieldNames,
  isPersonaComplete,
  normalizeStoredPersona,
  personaSchema,
  personaFieldLabels,
  type Persona
} from "./personaSchema.ts";
import { detectScopeConflict, type ScopeConflictWarning } from "#memory/memoryCategory.ts";
import {
  buildMemoryDedupDetails,
  buildMemoryWriteDiagnostics
} from "#memory/writeResult.ts";

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

  createEmpty(): Persona {
    return createEmptyPersona();
  }

  isComplete(persona: Persona): boolean {
    return isPersonaComplete(persona);
  }

  describeMissingFields(persona: Persona): Array<{ key: typeof editablePersonaFieldNames[number]; label: string }> {
    return describeMissingPersonaFields(persona).map((key) => ({
      key,
      label: personaFieldLabels[key]
    }));
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
    return (await this.patchWithDiagnostics(patch)).persona;
  }

  async patchWithDiagnostics(patch: Partial<Persona>): Promise<{
    persona: Persona;
    warning: ScopeConflictWarning | null;
  }> {
    const current = await this.get();
    const next = personaSchema.parse({
      ...current,
      ...patch
    });
    const warning = detectPersonaPatchConflict(patch);
    await this.write(next);
    const diagnostics = buildMemoryWriteDiagnostics({
      targetCategory: "persona",
      action: "updated_existing",
      dedup: buildMemoryDedupDetails({ matchedExisting: false }),
      warning
    });
    this.logger.info({
      patch,
      patchFields: Object.keys(patch),
      targetCategory: diagnostics.targetCategory,
      action: diagnostics.action,
      finalAction: diagnostics.finalAction,
      dedupMatchedBy: diagnostics.dedup.matchedBy,
      dedupMatchedExistingId: diagnostics.dedup.matchedExistingId,
      dedupSimilarityScore: diagnostics.dedup.similarityScore,
      rerouteResult: diagnostics.reroute.result,
      rerouteSuggestedScope: diagnostics.reroute.suggestedScope,
      rerouteReason: diagnostics.reroute.reason
    }, "persona_updated");
    if (warning) {
      this.logger.warn({
        targetCategory: "persona",
        suggestedScope: warning.suggestedScope,
        reason: warning.reason
      }, "memory_scope_conflict_detected");
    }
    return {
      persona: next,
      warning
    };
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

function detectPersonaPatchConflict(patch: Partial<Persona>): ScopeConflictWarning | null {
  const candidateFields: Array<keyof Persona> = [
    "name",
    "coreIdentity",
    "personality",
    "interests",
    "background",
    "speechStyle"
  ];
  for (const field of candidateFields) {
    const value = patch[field];
    if (!value?.trim()) {
      continue;
    }
    const warning = detectScopeConflict({
      currentScope: "persona",
      title: field,
      content: value
    });
    if (warning) {
      return warning;
    }
  }
  return null;
}

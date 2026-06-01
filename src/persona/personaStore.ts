import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
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
  constructor(
    dataDir: string,
    _config: AppConfig,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
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
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        name,
        temperament,
        voice_style AS voiceStyle
      FROM persona
      WHERE id = 'global'
    `).get() as Persona | undefined;
    const normalized = normalizeStoredPersona(row);
    if (normalized) {
      return normalized;
    }
    const initialPersona = createEmptyPersona();
    await this.write(initialPersona);
    this.logger.info("persona_initialized_for_setup");
    return initialPersona;
  }

  async write(persona: Persona): Promise<void> {
    const validated = personaSchema.parse(persona);
    this.stateDatabase.getDb().prepare(`
      INSERT INTO persona (
        id, name, temperament, voice_style, updated_at_ms
      )
      VALUES (
        'global', @name, @temperament, @voiceStyle, @updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        temperament = excluded.temperament,
        voice_style = excluded.voice_style,
        updated_at_ms = excluded.updated_at_ms
    `).run({
      ...validated,
      updatedAtMs: Date.now()
    });
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

}

function detectPersonaPatchConflict(patch: Partial<Persona>): ScopeConflictWarning | null {
  const candidateFields: Array<keyof Persona> = [
    "name",
    "temperament",
    "voiceStyle"
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

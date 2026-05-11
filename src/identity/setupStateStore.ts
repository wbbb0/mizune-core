import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { UserIdentityStore } from "./userIdentityStore.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import {
  getMissingPersonaFields,
  personaFieldLabels,
  type EditablePersonaFieldName,
  type Persona
} from "#persona/personaSchema.ts";
import { isPersonaInitializationRequired } from "#persona/personaSetupPolicy.ts";
import { setupStateSchema, type SetupStateRecord } from "./setupStateSchema.ts";

export class SetupStateStore {
  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "conversation">,
    private readonly userIdentityStore: Pick<UserIdentityStore, "hasOwnerIdentity">,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(persona: Persona): Promise<SetupStateRecord> {
    await this.stateDatabase.init();
    return this.readOrInitialize(persona);
  }

  async get(): Promise<SetupStateRecord> {
    await this.stateDatabase.init();
    return this.readOrInitialize();
  }

  async isReady(): Promise<boolean> {
    return (await this.get()).state === "ready";
  }

  describeMissingFields(persona: Persona): Array<{ key: EditablePersonaFieldName; label: string }> {
    return getMissingPersonaFields(persona).map((key) => ({
      key,
      label: personaFieldLabels[key]
    }));
  }

  async advanceAfterOwnerBound(persona: Persona): Promise<SetupStateRecord> {
    const current = await this.get();
    if (current.state === "ready") {
      return current;
    }
    return this.write({
      state: isPersonaInitializationRequired(this.config, persona) ? "needs_persona" : "ready",
      ownerPromptSentAt: null,
      updatedAt: Date.now()
    });
  }

  async advanceAfterPersonaUpdate(persona: Persona): Promise<SetupStateRecord> {
    const current = await this.get();
    if (current.state === "ready") {
      return current;
    }
    if (!await this.userIdentityStore.hasOwnerIdentity()) {
      return this.write({
        state: "needs_owner",
        ownerPromptSentAt: null,
        updatedAt: Date.now()
      });
    }
    return this.write({
      state: isPersonaInitializationRequired(this.config, persona) ? "needs_persona" : "ready",
      ownerPromptSentAt: current.ownerPromptSentAt,
      updatedAt: Date.now()
    });
  }

  async markOwnerPromptSent(at = Date.now()): Promise<SetupStateRecord> {
    const current = await this.get();
    return this.write({
      ...current,
      ownerPromptSentAt: at,
      updatedAt: at
    });
  }

  private async readOrInitialize(persona?: Persona): Promise<SetupStateRecord> {
    const current = this.stateDatabase.getDb().prepare(`
      SELECT
        state,
        owner_prompt_sent_at_ms AS ownerPromptSentAt,
        updated_at_ms AS updatedAt
      FROM setup_state
      WHERE id = 'global'
    `).get() as SetupStateRecord | undefined;
    if (current) {
      return setupStateSchema.parse(current);
    }
    const initial = await this.deriveInitialState(persona);
    await this.write(initial);
    this.logger.info("setup_state_initialized");
    return initial;
  }

  private async deriveInitialState(persona?: Persona): Promise<SetupStateRecord> {
    const now = Date.now();
    if (!await this.userIdentityStore.hasOwnerIdentity()) {
      return {
        state: "needs_owner",
        ownerPromptSentAt: null,
        updatedAt: now
      };
    }
    return {
      state: persona && !isPersonaInitializationRequired(this.config, persona) ? "ready" : "needs_persona",
      ownerPromptSentAt: null,
      updatedAt: now
    };
  }

  private async write(next: SetupStateRecord): Promise<SetupStateRecord> {
    const validated = setupStateSchema.parse(next);
    this.stateDatabase.getDb().prepare(`
      INSERT INTO setup_state (
        id,
        state,
        owner_prompt_sent_at_ms,
        updated_at_ms
      )
      VALUES (
        'global',
        @state,
        @ownerPromptSentAt,
        @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        owner_prompt_sent_at_ms = excluded.owner_prompt_sent_at_ms,
        updated_at_ms = excluded.updated_at_ms
    `).run(validated);
    return validated;
  }
}

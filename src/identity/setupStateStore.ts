import { join } from "node:path";
import type { Logger } from "pino";
import type { UserIdentityStore } from "./userIdentityStore.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import {
  getMissingPersonaFields,
  isPersonaComplete,
  personaFieldLabels,
  type EditablePersonaFieldName,
  type Persona
} from "#persona/personaSchema.ts";
import { setupStateSchema, type SetupStateRecord } from "./setupStateSchema.ts";

export class SetupStateStore {
  private readonly store: FileSchemaStore<typeof setupStateSchema>;

  constructor(
    dataDir: string,
    private readonly userIdentityStore: Pick<UserIdentityStore, "hasOwnerIdentity">,
    private readonly logger: Logger
  ) {
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "setup-state.json"),
      schema: setupStateSchema,
      logger,
      loadErrorEvent: "setup_state_reset_to_initial"
    });
  }

  async init(persona: Persona): Promise<SetupStateRecord> {
    return this.readOrInitialize(persona);
  }

  async get(): Promise<SetupStateRecord> {
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
      state: isPersonaComplete(persona) ? "ready" : "needs_persona",
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
      state: isPersonaComplete(persona) ? "ready" : "needs_persona",
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
    try {
      const current = await this.store.read();
      if (current) {
        return current;
      }
    } catch (error: unknown) {
      this.logger.warn({ error }, "setup_state_reset_to_initial");
    }
    const initial = await this.deriveInitialState(persona);
    await this.write(initial);
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
      state: persona && isPersonaComplete(persona) ? "ready" : "needs_persona",
      ownerPromptSentAt: null,
      updatedAt: now
    };
  }

  private async write(next: SetupStateRecord): Promise<SetupStateRecord> {
    return this.store.write(next);
  }
}

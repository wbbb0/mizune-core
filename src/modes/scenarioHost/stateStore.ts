import { join } from "node:path";
import type { Logger } from "pino";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import type { AppConfig } from "#config/config.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";
import { resolveSessionParticipantLabel } from "#conversation/session/sessionIdentity.ts";
import {
  createInitialScenarioHostSessionState,
  scenarioHostSessionStateSchema,
  type ScenarioHostSessionState
} from "./types.ts";

function encodeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export class ScenarioHostStateStore {
  constructor(
    private readonly dataDir: string,
    private readonly _config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {}

  async init(): Promise<void> {
    return;
  }

  async get(sessionId: string): Promise<ScenarioHostSessionState | null> {
    return this.createStore(sessionId).read();
  }

  async ensure(
    sessionId: string,
    defaults: {
      playerUserId: string;
      playerDisplayName: string;
    }
  ): Promise<ScenarioHostSessionState> {
    return this.createStore(sessionId).readOrCreate(() => createInitialScenarioHostSessionState(defaults));
  }

  async write(sessionId: string, state: ScenarioHostSessionState): Promise<ScenarioHostSessionState> {
    return this.createStore(sessionId).write(scenarioHostSessionStateSchema.parse(state));
  }

  async update(
    sessionId: string,
    updater: (current: ScenarioHostSessionState) => ScenarioHostSessionState | Promise<ScenarioHostSessionState>,
    defaults: {
      playerUserId: string;
      playerDisplayName: string;
    }
  ): Promise<ScenarioHostSessionState> {
    const store = this.createStore(sessionId);
    return store.updateExisting(
      async (current) => scenarioHostSessionStateSchema.parse(await updater(current)),
      () => createInitialScenarioHostSessionState(defaults)
    );
  }

  async ensureForSession(session: Pick<SessionState, "id" | "participantUserId" | "participantLabel">): Promise<ScenarioHostSessionState> {
    return this.ensure(session.id, {
      playerUserId: session.participantUserId,
      playerDisplayName: resolveSessionParticipantLabel({
        sessionId: session.id,
        participantLabel: session.participantLabel,
        participantUserId: session.participantUserId
      })
    });
  }

  private createStore(sessionId: string) {
    return new FileSchemaStore({
      filePath: join(this.dataDir, "scenario-host", "sessions", `${encodeSessionId(sessionId)}.json`),
      schema: scenarioHostSessionStateSchema,
      logger: this.logger,
      loadErrorEvent: "scenario_host_state_store_load_failed",
      atomicWrite: true
    });
  }
}

import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { characterRepository, type CharacterRepository } from "../../character/repository.ts";
import type { StatefulRpSessionState } from "./types.ts";

/** 模式存储视图；固定档案和会话状态由同一个角色仓库维护。 */
export class StatefulRpStateStore {
  readonly characters: CharacterRepository;
  constructor(dataDir: string, _config: Pick<AppConfig, "backup">, _logger: Logger) { this.characters = characterRepository(dataDir); }
  async init(): Promise<void> { this.characters.profile(); }
  async get(id: string): Promise<StatefulRpSessionState | null> { return this.characters.findState(id); }
  async ensure(id: string): Promise<StatefulRpSessionState> { return this.characters.state(id); }
  async ensureForSession(session: { id: string }): Promise<StatefulRpSessionState> { return this.ensure(session.id); }
  async write(id: string, state: StatefulRpSessionState): Promise<StatefulRpSessionState> { return this.characters.restoreState(id, state); }
  async writeIfCurrent(id: string, state: StatefulRpSessionState, expectedRevision: string, isCurrent: () => boolean): Promise<StatefulRpSessionState | null> {
    return this.characters.commitState(id, state, expectedRevision, isCurrent);
  }
  async delete(id: string): Promise<boolean> { return this.characters.deleteState(id); }
  async listRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}) { return this.characters.listStates(input); }
}

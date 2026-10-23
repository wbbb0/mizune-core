import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { emptyCharacter, emptyCharacterSession, nextCharacterStage, stageRoot, type CharacterDraft, type CharacterProfile, type CharacterSession, type CharacterStage } from "./model.ts";
import { characterSections, emptyValue, getCharacterSection, readPath, setPath, validateJson, personaJsonSchema, socialJsonSchema, embodimentJsonSchema, socialStateJsonSchema, simulationJsonSchema, tierForMode, type JsonObject } from "./schemaCatalog.ts";
import { advanceCycle, cycleParameters, gameDate, dateNumber } from "./cycle.ts";

const layerSchemas = { persona: personaJsonSchema, social: socialJsonSchema, embodiment: embodimentJsonSchema };
export class CharacterRepository {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "character.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS character_documents (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  close(): void { this.db.close(); }
  private read<T>(id: string): T | null {
    const row = this.db.prepare("SELECT value FROM character_documents WHERE id = ?").get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }
  private write(id: string, value: unknown): void {
    this.db.prepare("INSERT INTO character_documents(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(value));
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  profile(): CharacterProfile {
    const existing = this.read<CharacterProfile>("profile");
    if (existing) return existing;
    const value = emptyCharacter();
    this.db.prepare("INSERT OR IGNORE INTO character_documents(id,value) VALUES ('profile',?)").run(JSON.stringify(value));
    return this.read<CharacterProfile>("profile")!;
  }
  findState(sessionId: string): CharacterSession | null { return this.read(`state:${sessionId}`); }
  deleteState(sessionId: string): boolean { this.cancel(sessionId); return this.db.prepare("DELETE FROM character_documents WHERE id = ?").run(`state:${sessionId}`).changes > 0; }
  restoreState(sessionId: string, value: CharacterSession): CharacterSession {
    return this.transaction(() => { const state = structuredClone(value); this.validateState(state); state.revision = randomUUID(); this.write(`state:${sessionId}`, state); return state; });
  }
  commitState(sessionId: string, value: CharacterSession, expectedRevision: string, isCurrent: () => boolean): CharacterSession | null {
    return this.transaction(() => {
      if (!isCurrent() || this.draft(sessionId) || this.findState(sessionId)?.revision !== expectedRevision) return null;
      const state = structuredClone(value); this.validateState(state); advanceCycle(this.profile(), state);
      state.revision = randomUUID(); this.write(`state:${sessionId}`, state); return state;
    });
  }
  listStates(input: { offset?: number; limit?: number; filters?: Record<string, unknown> }) {
    const offset = Math.max(0, Math.trunc(input.offset ?? 0)), limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
    const rows = (this.db.prepare("SELECT id,value FROM character_documents WHERE id LIKE 'state:%' ORDER BY id").all() as Array<{id:string;value:string}>).filter(row => !input.filters?.sessionId || row.id.slice(6) === input.filters.sessionId);
    return { total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit).map(row => ({ sessionId: row.id.slice(6), state: JSON.parse(row.value) as CharacterSession, updatedAtMs: 0 })) };
  }
  state(sessionId: string): CharacterSession {
    const key = `state:${sessionId}`;
    const existing = this.read<CharacterSession>(key);
    if (existing) return existing;
    const value = emptyCharacterSession();
    this.db.prepare("INSERT OR IGNORE INTO character_documents(id,value) VALUES (?,?)").run(key, JSON.stringify(value));
    return this.read<CharacterSession>(key)!;
  }
  draft(sessionId: string): CharacterDraft | null { return this.read(`draft:${sessionId}`); }
  requiredStage(sessionId: string, mode: string): CharacterStage | null { return nextCharacterStage(this.profile(), this.state(sessionId), mode); }
  begin(sessionId: string, stage: CharacterStage, phase: "setup" | "config", mode: string): CharacterDraft {
    return this.transaction(() => {
      if (this.draft(sessionId)) throw new Error("请先确认或取消当前角色草稿");
      const profile = this.profile(); const state = this.state(sessionId);
      const allowed = stage === "state" ? tierForMode(mode) === 3 : ["persona", "social", "embodiment"].indexOf(stage) < tierForMode(mode);
      if (!allowed) throw new Error("当前模式不使用此配置层");
      const draft: CharacterDraft = {
        id: randomUUID(), stage, phase, baseRevision: stage === "state" ? state.revision : profile.revision,
        profileRevision: profile.revision,
        value: phase === "config" ? stageRoot(profile, state, stage) : stageRoot(emptyCharacter(), emptyCharacterSession(), stage),
        touched: [], introduction: "pending"
      };
      if (stage === "state" && phase === "setup") {
        if (!state.initialized) draft.value.social = structuredClone(state.social);
        draft.value.simulation.clock = emptyValue({ ...simulationJsonSchema.properties.clock, type: "object" });
        draft.value.simulation.clock.currentIso = new Date().toISOString();
        draft.value.simulation.clock.timezone = "Asia/Shanghai";
        const items = profile.embodiment.wardrobe.items as JsonObject[];
        draft.value.simulation.wardrobe.instances = items.flatMap(item => Array.from({ length: item.quantity ?? 1 }, () => ({
          ...emptyValue(simulationJsonSchema.properties.wardrobe.properties.instances.items), instanceId: randomUUID(), itemId: item.id, definition: structuredClone(item), location: "wardrobe"
        })));
      }
      this.write(`draft:${sessionId}`, draft); return draft;
    });
  }
  ensureSetup(sessionId: string, mode: string): CharacterDraft | null {
    const current = this.draft(sessionId); if (current) return current;
    const stage = this.requiredStage(sessionId, mode); return stage ? this.begin(sessionId, stage, "setup", mode) : null;
  }
  claimIntroduction(sessionId: string): boolean {
    return this.transaction(() => {
      const draft = this.draft(sessionId); if (!draft || draft.introduction !== "pending") return false;
      draft.introduction = "claimed"; this.write(`draft:${sessionId}`, draft); return true;
    });
  }
  cancel(sessionId: string): void { this.db.prepare("DELETE FROM character_documents WHERE id = ?").run(`draft:${sessionId}`); }
  reset(sessionId: string): void { this.transaction(() => { this.cancel(sessionId); this.write(`state:${sessionId}`, emptyCharacterSession()); }); }
  sections(sessionId: string, mode: string) {
    const draft = this.draft(sessionId);
    if (!draft && this.requiredStage(sessionId, mode)) return [];
    return characterSections.filter(section => section.tier <= tierForMode(mode) && (draft ? draft.stage === "state" ? section.scope === "session" : section.scope === "character" && section.path[0] === draft.stage : true));
  }
  section(sessionId: string, mode: string, id: string) {
    const section = this.sections(sessionId, mode).find(item => item.id === id);
    if (!section) throw new Error("当前阶段不可访问此分块");
    const draft = this.draft(sessionId);
    const root = draft?.value ?? (section.scope === "character" ? this.profile() : this.state(sessionId));
    return { ...section, value: readPath(root, section.path), touched: draft?.touched.includes(id) ?? false };
  }
  edit(sessionId: string, mode: string, id: string, action: "set" | "upsert" | "remove" | "skip", value?: unknown, itemId?: string, draftId?: string): void {
    this.transaction(() => {
      const draft = this.draft(sessionId);
      if (draftId !== draft?.id) throw new Error("配置阶段已变化，请重新读取目录");
      const section = this.section(sessionId, mode, id);
      if (!draft && section.scope === "character") throw new Error("固定设定只能进入配置草稿后修改");
      if (!draft && tierForMode(mode) === 3 && !this.state(sessionId).initialized) throw new Error("请先完成会话初始化");
      if (!draft && action === "skip") throw new Error("跳过仅用于配置草稿");
      const state = this.state(sessionId); const root = draft?.value ?? state;
      const current = readPath(root, section.path);
      let next: unknown;
      if (action === "skip") next = emptyValue(section.schema);
      else if (action === "set") {
        if (section.collectionKey && Array.isArray(value) && value.length) throw new Error("此集合请按单条 ID 使用 upsert，不能整体覆盖");
        next = value;
      } else {
        if (!section.collectionKey) throw new Error("此分块不是可按 ID 编辑的集合");
        const items = structuredClone(current ?? []) as JsonObject[];
        if (action === "remove") next = items.filter(item => item[section.collectionKey!] !== itemId);
        else {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("条目必须是对象");
          const item = structuredClone(value) as JsonObject;
          item[section.collectionKey] ??= itemId || randomUUID();
          validateJson(section.schema.items, item, `${id}.item`);
          const index = items.findIndex(row => row[section.collectionKey!] === item[section.collectionKey!]);
          if (index < 0) items.push(item); else items[index] = item;
          next = items;
        }
      }
      validateJson(section.schema, next, id);
      protectDerivedState(id, current, next, draft?.stage === "state");
      if (draft?.stage === "state" && id === "session.simulation.body.activePhysiology.menstrualCycle" && next && (next as JsonObject).lastStartDate !== current?.lastStartDate) {
        next = { ...(next as JsonObject), nextStartDate: null, currentEndDate: null, active: false };
      }
      setPath(root, section.path, next);
      if (draft) { if (!draft.touched.includes(id)) draft.touched.push(id); this.write(`draft:${sessionId}`, draft); }
      else {
        this.validateState(state);
        advanceCycle(this.profile(), state);
        state.revision = randomUUID(); this.write(`state:${sessionId}`, state);
      }
    });
  }
  skipDraftSection(sessionId: string, mode: string, id: string, draftId: string): void {
    this.transaction(() => {
      const draft = this.draft(sessionId);
      if (!draft || draft.id !== draftId) throw new Error("配置阶段已变化，请重新读取目录");
      this.section(sessionId, mode, id);
      if (!draft.touched.includes(id)) draft.touched.push(id);
      this.write(`draft:${sessionId}`, draft);
    });
  }
  confirm(sessionId: string, mode: string): CharacterStage {
    return this.transaction(() => {
      const draft = this.draft(sessionId); if (!draft) throw new Error("没有待确认的角色草稿");
      if ((draft.stage === "state" && tierForMode(mode) !== 3) || (draft.stage !== "state" && ["persona", "social", "embodiment"].indexOf(draft.stage) >= tierForMode(mode))) throw new Error("模式已改变，请取消此草稿");
      const profile = this.profile(); const state = this.state(sessionId);
      if (draft.baseRevision !== (draft.stage === "state" ? state.revision : profile.revision)) throw new Error("配置已在其他会话修改，请取消后重新进入配置");
      if (draft.stage === "state") {
        if (draft.profileRevision !== profile.revision) throw new Error("角色设定已变化，请重新初始化会话草稿");
        Object.assign(state, draft.value);
        state.initialized = true; state.simulation.initialized = true;
        this.validateState(state);
        advanceCycle(profile, state);
        state.revision = randomUUID(); this.write(`state:${sessionId}`, state);
      } else {
        const layer = draft.stage;
        validateJson(layerSchemas[layer], draft.value[layer], layer);
        profile[layer] = draft.value[layer];
        validateFixed(profile);
        if (!profile.confirmed.includes(layer)) profile.confirmed.push(layer);
        profile.revision = randomUUID(); this.write("profile", profile);
      }
      this.cancel(sessionId); return draft.stage;
    });
  }
  sync(sessionId: string): CharacterSession {
    return this.transaction(() => {
      const state = this.state(sessionId); if (!state.initialized) return state;
      const before = JSON.stringify(state); advanceCycle(this.profile(), state);
      if (before !== JSON.stringify(state)) { state.revision = randomUUID(); this.write(`state:${sessionId}`, state); }
      return state;
    });
  }
  private validateState(state: CharacterSession): void {
    validateJson(socialStateJsonSchema, state.social, "session.social");
    validateJson(simulationJsonSchema, state.simulation, "session.simulation");
    const clock = state.simulation.clock;
    if (clock?.currentIso) gameDate(clock.currentIso, clock.timezone);
    const wardrobe = state.simulation.wardrobe;
    unique(wardrobe.instances, "instanceId"); unique(wardrobe.acquiredItems, "id"); unique(wardrobe.worn, "instanceId");
    const ids = new Set(wardrobe.instances.map((item: JsonObject) => item.instanceId));
    for (const worn of wardrobe.worn) if (!ids.has(worn.instanceId)) throw new Error("穿戴记录引用不存在的衣物实例");
  }
}
function unique(items: JsonObject[], key: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (typeof item[key] !== "string" || !item[key].trim() || ids.has(item[key])) throw new Error(`${key} 必须非空且唯一`);
    ids.add(item[key]);
  }
}
function validateFixed(profile: CharacterProfile): void {
  const wardrobe = profile.embodiment.wardrobe;
  unique(wardrobe.items, "id"); unique(wardrobe.outfits, "id");
  for (const item of wardrobe.items) if (item.quantity != null && (!Number.isInteger(item.quantity) || item.quantity < 0 || item.quantity > 1000)) throw new Error("物品数量必须是 0 至 1000 的整数或留空");
  const ids = new Set(wardrobe.items.map((item: JsonObject) => item.id));
  for (const outfit of wardrobe.outfits) if (outfit.itemIds.some((id: string) => !ids.has(id))) throw new Error("搭配引用不存在的衣物模板");
  for (const [name, mechanism] of Object.entries(profile.embodiment.physiology) as Array<[string, JsonObject | null]>) {
    if (mechanism?.mode === "disabled" && !mechanism.reason?.trim()) throw new Error(`${name} 关闭时需要填写原因`);
    if (mechanism?.mode === "standard" && name !== "menstrualCycle") throw new Error(`${name} 暂未实现标准计算，可留空或使用 narrative`);
  }
  cycleParameters(profile);
}
function protectDerivedState(id: string, previous: unknown, next: unknown, setup: boolean): void {
  if (!id.startsWith("session.")) return;
  const old = previous as JsonObject | null, value = next as JsonObject | null;
  if (id === "session.simulation.body.activePhysiology.menstrualCycle") {
    if (setup && value == null) return;
    for (const key of ["nextStartDate", "currentEndDate", "active"]) if (JSON.stringify(value?.[key] ?? null) !== JSON.stringify(old?.[key] ?? (key === "active" ? false : null))) throw new Error("周期发生状态由代码控制");
    if (!setup && value?.lastStartDate !== old?.lastStartDate) throw new Error("周期日期校正请进入 .config state");
    if (value?.lastStartDate) dateNumber(value.lastStartDate);
  }
  if (id === "session.simulation.clock") {
    if (!setup && old?.currentIso && !value?.currentIso) throw new Error("清空游戏时钟请进入 .config state");
    if (value) for (const key of ["minutesSinceLastSensoryTick", "minutesSinceLastMindTick", "separatedMinutesAccumulated"]) if (value[key] !== (old?.[key] ?? 0)) throw new Error("维护计时器由代码管理");
  }
  if (id === "session.simulation.clock" && old?.currentIso && value?.currentIso && !setup && Date.parse(value.currentIso) < Date.parse(old.currentIso)) throw new Error("普通游玩不能倒退游戏时钟");
}
const repositories = new Map<string, CharacterRepository>();
export function characterRepository(dataDir: string): CharacterRepository {
  const key = resolve(dataDir); let store = repositories.get(key);
  if (!store) { store = new CharacterRepository(key); repositories.set(key, store); }
  return store;
}

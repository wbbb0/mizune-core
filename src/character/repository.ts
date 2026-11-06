import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { emptyCharacter, emptyCharacterSession, nextCharacterStage, stageRoot, type CharacterDraft, type CharacterProfile, type CharacterSession, type CharacterStage } from "./model.ts";
import { characterSections, emptyValue, getCharacterSection, mergeSectionPatch, normalizeReferenceSubject, readPath, readSectionValue, setPath, validateJson, personaJsonSchema, socialJsonSchema, embodimentJsonSchema, socialStateJsonSchema, simulationJsonSchema, tierForMode, type CharacterSection, type JsonObject } from "./schemaCatalog.ts";
import { advanceCycle, cycleParameters, gameDate, dateNumber } from "./cycle.ts";

const fixedStages = ["persona", "social", "embodiment"] as const;
const layerSchemas = { persona: personaJsonSchema, social: socialJsonSchema, embodiment: embodimentJsonSchema };
export interface CharacterCommitGuard {
  assertCurrent?: () => void;
  draft?: CharacterDraft;
  section?: { id: string; itemId?: string; value: unknown };
}
export type CharacterEditAction = "set" | "patch" | "upsert" | "add" | "update" | "remove" | "skip";
export interface CharacterEditResult { itemId: string; item: JsonObject }
export class CharacterRepository {
  private readonly db: DatabaseSync;
  private readonly dataDirKey: string;
  constructor(dataDir: string) {
    this.dataDirKey = resolve(dataDir);
    mkdirSync(this.dataDirKey, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDirKey, "character.sqlite"));
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
  private assertCommitGuard(sessionId: string, mode: string, guard?: CharacterCommitGuard): void {
    guard?.assertCurrent?.();
    if (guard?.draft) {
      const current = this.draft(sessionId);
      const snapshot = (draft: CharacterDraft | null) => draft && {
        id: draft.id, stage: draft.stage, baseRevision: draft.baseRevision,
        profileRevision: draft.profileRevision, value: draft.value
      };
      if (JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(guard.draft))) {
        throw new Error("角色草稿在校验期间已变化，请重新读取后再确认");
      }
    }
    if (guard?.section) {
      const current = this.section(sessionId, mode, guard.section.id, guard.section.itemId).value;
      if (JSON.stringify(current) !== JSON.stringify(guard.section.value)) {
        throw new Error("目标分块或条目在校验期间已变化，请重新读取后再修改");
      }
    }
  }
  profile(): CharacterProfile {
    const existing = this.read<CharacterProfile>("profile");
    if (existing) return normalizeProfileDefaults(existing);
    const value = emptyCharacter();
    this.db.prepare("INSERT OR IGNORE INTO character_documents(id,value) VALUES ('profile',?)").run(JSON.stringify(value));
    return normalizeProfileDefaults(this.read<CharacterProfile>("profile")!);
  }
  referencedFileIds(): Set<string> {
    const rows = this.db.prepare("SELECT id, value FROM character_documents WHERE id = 'profile' OR id LIKE 'draft:%'").all() as Array<{ id: string; value: string }>;
    const fileIds = new Set<string>();
    for (const row of rows) {
      const parsed = JSON.parse(row.value) as JsonObject;
      if (row.id !== "profile" && parsed?.stage !== "social") continue;
      const root = row.id === "profile" ? parsed : parsed?.value;
      const items = root?.social?.referenceImages;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item?.fileId === "string" && item.fileId.trim()) {
          fileIds.add(item.fileId.trim());
        }
      }
    }
    return fileIds;
  }
  /** Data 编辑与聊天确认共用固定档案校验；系统元数据只能由仓库维护。 */
  validateProfile(value: unknown): CharacterProfile {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("角色档案必须是对象");
    const candidate = normalizeProfileDefaults(structuredClone(value) as CharacterProfile);
    const keys = Object.keys(candidate);
    if (keys.length !== 5 || !["revision", "confirmed", "persona", "social", "embodiment"].every(key => keys.includes(key))) throw new Error("角色档案字段不完整或包含未知字段");
    const current = this.profile();
    if (typeof candidate.revision !== "string" || candidate.revision !== current.revision) throw new Error("角色设定已被其他保存更新，请重新读取后再保存");
    if (JSON.stringify(candidate.confirmed) !== JSON.stringify(current.confirmed)) throw new Error("确认状态由系统维护，不能直接修改");
    normalizeReferenceImagesInSocial(candidate.social);
    for (const layer of fixedStages) validateJson(layerSchemas[layer], candidate[layer], layer);
    validateFixed(candidate, current);
    return candidate;
  }
  saveProfile(value: unknown, assertCurrent?: () => void): CharacterProfile {
    return this.transaction(() => {
      assertCurrent?.();
      const next = this.validateProfile(value);
      const previous = this.profile();
      for (const layer of ["persona", "social", "embodiment"] as const) {
        if (JSON.stringify(next[layer]) !== JSON.stringify(previous[layer]) && !next.confirmed.includes(layer)) next.confirmed.push(layer);
      }
      next.revision = randomUUID();
      this.write("profile", next);
      return next;
    });
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
  markIntroductionDelivered(sessionId: string, expectedDraftId: string): boolean {
    return this.transaction(() => {
      const draft = this.draft(sessionId);
      if (!draft || draft.id !== expectedDraftId || draft.introduction === "delivered") return false;
      draft.introduction = "delivered";
      this.write(`draft:${sessionId}`, draft);
      return true;
    });
  }
  cancel(sessionId: string): void { this.db.prepare("DELETE FROM character_documents WHERE id = ?").run(`draft:${sessionId}`); }
  reset(sessionId: string): void { this.transaction(() => { this.cancel(sessionId); this.write(`state:${sessionId}`, emptyCharacterSession()); }); }
  sections(sessionId: string, mode: string): Array<CharacterSection & { writable: boolean; touched: boolean }> {
    const draft = this.draft(sessionId);
    if (!draft && this.requiredStage(sessionId, mode)) return [];
    const tier = tierForMode(mode);
    if (!draft) {
      return characterSections
        .filter(section => section.tier <= tier)
        .map(section => ({ ...section, writable: section.scope === "session", touched: false }));
    }
    const draftStageIndex = draft.stage === "state" ? fixedStages.length : fixedStages.indexOf(draft.stage);
    const confirmed = this.profile().confirmed;
    return characterSections.flatMap((section): Array<CharacterSection & { writable: boolean; touched: boolean }> => {
      if (section.tier > tier) return [];
      const isCurrentStage = draft.stage === "state"
        ? section.scope === "session"
        : section.scope === "character" && section.path[0] === draft.stage;
      if (isCurrentStage) {
        return [{ ...section, writable: true, touched: draft.touched.includes(section.id) }];
      }
      if (section.scope === "character") {
        const layer = section.path[0] as typeof fixedStages[number];
        if (fixedStages.indexOf(layer) < draftStageIndex && confirmed.includes(layer)) {
          return [{ ...section, writable: false, touched: false }];
        }
      }
      return [];
    });
  }
  section(sessionId: string, mode: string, id: string, itemId?: unknown): CharacterSection & { writable: boolean; touched: boolean; value: any; itemId?: string } {
    const section = this.sections(sessionId, mode).find(item => item.id === id);
    if (!section) throw new Error("当前阶段不可访问此分块");
    const draft = this.draft(sessionId);
    const root = draft && section.writable
      ? draft.value
      : section.scope === "character"
        ? this.profile()
        : this.state(sessionId);
    const fullValue = readSectionValue(root, section);
    if (itemId !== undefined) {
      if (!section.collectionKey) throw new Error("此分块不是可按条目 ID 读取的集合");
      if (typeof itemId !== "string" || !itemId.trim()) throw new Error("需要有效的 itemId");
      const trimmedItemId = itemId.trim();
      const items = Array.isArray(fullValue) ? (fullValue as JsonObject[]) : [];
      const matched = items.find(item => item?.[section.collectionKey!] === trimmedItemId);
      if (!matched) throw new Error(`未找到条目：${trimmedItemId}`);
      return { ...section, value: structuredClone(matched), itemId: trimmedItemId };
    }
    return { ...section, value: structuredClone(fullValue) };
  }
  edit(sessionId: string, mode: string, id: string, action: CharacterEditAction, value?: unknown, itemId?: string, draftId?: string, guard?: CharacterCommitGuard): CharacterEditResult | undefined {
    return this.transaction(() => {
      this.assertCommitGuard(sessionId, mode, guard);
      const draft = this.draft(sessionId);
      if (draftId !== draft?.id) throw new Error("配置阶段已变化，请重新读取目录");
      const section = this.section(sessionId, mode, id);
      if (!draft && section.scope === "character") throw new Error("固定设定只能进入配置草稿后修改");
      if (!section.writable) throw new Error("当前阶段此分块为只读，不能修改");
      if (!draft && tierForMode(mode) === 3 && !this.state(sessionId).initialized) throw new Error("请先完成会话初始化");
      if (!draft && action === "skip") throw new Error("跳过仅用于配置草稿");
      const state = this.state(sessionId); const root = draft?.value ?? state;
      const current = readSectionValue(root, section);
      let next: unknown;
      let editedItemId: string | undefined;
      let editedItem: JsonObject | undefined;
      if (action === "skip") next = emptyValue(section.schema);
      else if (action === "set" || action === "patch") {
        if (section.collectionKey && Array.isArray(value) && value.length) throw new Error("此集合请按单条 ID 使用 upsert，不能整体覆盖");
        if (action === "patch" && section.collectionKey) throw new Error("集合请使用条目修改操作");
        next = action === "patch" ? mergeSectionPatch(current, value, section.schema) : value;
      } else {
        if (!section.collectionKey) throw new Error("此分块不是可按 ID 编辑的集合");
        const items = structuredClone(current ?? []) as JsonObject[];
        if (action === "remove") next = items.filter(item => item[section.collectionKey!] !== itemId);
        else {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("条目必须是对象");
          const patch = structuredClone(value) as JsonObject;
          if (action === "update" && (!itemId || !items.some(row => row[section.collectionKey!] === itemId))) {
            throw new Error("itemId 不存在，请重新读取已有条目");
          }
          if (action === "update" && section.immutableItemFields?.some(field => field in patch)) {
            throw new Error("已存在条目的来源字段不可修改");
          }
          const previousItem = items.find(row => row[section.collectionKey!] === itemId);
          const item = action === "update"
            ? mergeSectionPatch(previousItem, patch, section.schema.items) as JsonObject
            : action === "add"
              ? mergeSectionPatch(emptyValue(section.schema.items), patch, section.schema.items) as JsonObject
              : patch;
          if (itemId && item[section.collectionKey] && item[section.collectionKey] !== itemId) {
            throw new Error("条目 ID 与 itemId 参数不一致");
          }
          if (action === "add" && (section.collectionKey === "id" || id === "session.simulation.wardrobe.instances")) {
            item[section.collectionKey] = randomUUID();
          } else item[section.collectionKey] ??= itemId || randomUUID();
          if (id === "social.referenceImages") {
            if (typeof item.fileId === "string") item.fileId = item.fileId.trim();
            if ("subject" in item) item.subject = normalizeReferenceSubject(item.subject);
          }
          validateJson(section.schema.items, item, `${id}.item`);
          const index = items.findIndex(row => row[section.collectionKey!] === item[section.collectionKey!]);
          if (action === "add" && index >= 0) throw new Error("此引用已有记录，请使用修改工具");
          if (index < 0) items.push(item); else items[index] = item;
          editedItemId = item[section.collectionKey];
          editedItem = item;
          next = items;
        }
      }
      validateJson(section.schema, next, id);
      if (id === "social.referenceImages") {
        const baseline = [...(Array.isArray(current) ? current : []), ...(this.profile().social.referenceImages ?? [])] as JsonObject[];
        validateReferenceImages(next as JsonObject[], baseline);
      }
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
      return editedItemId !== undefined && editedItem ? { itemId: editedItemId, item: structuredClone(editedItem) } : undefined;
    });
  }
  skipDraftSection(sessionId: string, mode: string, id: string, draftId: string): void {
    this.transaction(() => {
      const draft = this.draft(sessionId);
      if (!draft || draft.id !== draftId) throw new Error("配置阶段已变化，请重新读取目录");
      const section = this.section(sessionId, mode, id);
      if (!section.writable) throw new Error("当前阶段此分块为只读，不能跳过");
      if (!draft.touched.includes(id)) draft.touched.push(id);
      this.write(`draft:${sessionId}`, draft);
    });
  }
  confirm(sessionId: string, mode: string, guard?: CharacterCommitGuard): CharacterStage {
    return this.transaction(() => {
      this.assertCommitGuard(sessionId, mode, guard);
      const draft = this.draft(sessionId); if (!draft) throw new Error("没有待确认的角色草稿");
      if ((draft.stage === "state" && tierForMode(mode) !== 3) || (draft.stage !== "state" && fixedStages.indexOf(draft.stage) >= tierForMode(mode))) throw new Error("模式已改变，请取消此草稿");
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
        const previousProfile = structuredClone(profile);
        if (layer === "social") normalizeReferenceImagesInSocial(draft.value.social);
        validateJson(layerSchemas[layer], draft.value[layer], layer);
        profile[layer] = draft.value[layer];
        validateFixed(profile, previousProfile);
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
function normalizeProfileDefaults(profile: CharacterProfile): CharacterProfile {
  for (const section of characterSections) {
    if (section.scope !== "character" || section.schema.type !== "array" || section.schema.default === undefined) continue;
    const parent = readPath(profile, section.path.slice(0, -1));
    const leafKey = section.path.at(-1)!;
    if (parent && typeof parent === "object" && !Array.isArray(parent) && parent[leafKey] === undefined) {
      parent[leafKey] = emptyValue(section.schema);
    }
  }
  return profile;
}
function normalizeReferenceImagesInSocial(social: JsonObject | undefined): void {
  if (!social || typeof social !== "object" || Array.isArray(social)) return;
  if (social.referenceImages === undefined) {
    social.referenceImages = [];
    return;
  }
  if (!Array.isArray(social.referenceImages)) return;
  for (const item of social.referenceImages) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (typeof item.fileId === "string") item.fileId = item.fileId.trim();
      if ("subject" in item) item.subject = normalizeReferenceSubject(item.subject);
    }
  }
}
export function validateReferenceImages(items: JsonObject[], previousItems: JsonObject[] = []): void {
  if (!Array.isArray(items)) throw new Error("referenceImages 必须是数组");
  if (items.length > 8) throw new Error("参考图最多保存 8 条");
  unique(items, "id");
  const pairKeys = new Set<string>();
  const previousById = new Map<string, JsonObject>();
  for (const prev of previousItems) {
    if (prev && typeof prev.id === "string" && prev.id.trim() && !previousById.has(prev.id)) {
      previousById.set(prev.id, prev);
    }
  }
  for (const item of items) {
    if (typeof item.fileId !== "string" || !item.fileId.trim()) throw new Error("fileId 必须非空");
    item.fileId = item.fileId.trim();
    if (typeof item.label !== "string" || !item.label.trim()) throw new Error("label 必须非空");
    if (typeof item.description !== "string" || !item.description.trim()) throw new Error("description 必须非空");
    if (item.description.length > 12000) throw new Error("description 长度不能超过 12000");
    const subject = normalizeReferenceSubject(item.subject);
    if (subject !== null && typeof subject !== "string") throw new Error("subject 必须是字符串或 null");
    item.subject = subject;
    const pairKey = `${item.fileId}\u0000${subject ?? ""}`;
    if (pairKeys.has(pairKey)) throw new Error("同一图片与主体（fileId + subject）不能重复添加参考图");
    pairKeys.add(pairKey);
    const prev = previousById.get(item.id);
    if (prev) {
      const prevFileId = typeof prev.fileId === "string" ? prev.fileId.trim() : prev.fileId;
      const prevSubject = normalizeReferenceSubject(prev.subject);
      if (item.fileId !== prevFileId || subject !== prevSubject) {
        throw new Error("已存在参考图的来源字段（fileId、subject）不可修改");
      }
    }
  }
}
function validateFixed(profile: CharacterProfile, previousProfile?: CharacterProfile): void {
  validateReferenceImages(
    (profile.social.referenceImages ?? []) as JsonObject[],
    (previousProfile?.social?.referenceImages ?? []) as JsonObject[]
  );
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
export function characterReferencedFileIds(dataDir: string): Set<string> {
  const key = resolve(dataDir);
  if (!repositories.has(key) && !existsSync(join(key, "character.sqlite"))) return new Set();
  return characterRepository(key).referencedFileIds();
}

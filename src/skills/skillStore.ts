import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "../config/config.ts";
import type { SkillRecord, SkillSummary, SkillWriteInput } from "../types/skills.ts";
import { parseSkillDocument, validateSkillId, validateSkillResources, estimateSkillTokens, skillFingerprint } from "./skillDocument.ts";
import { builtinSkills } from "./builtinSkills.ts";
import { TOOLSET_DEFINITIONS } from "../llm/tools/toolsetCatalog.ts";
export class SkillError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
interface SkillIndex {
  entries: Record<string, number>;
  deleted: Record<string, number>;
  published: Record<string, number[]>;
  initialized: boolean;
}
export class SkillStore {
  readonly root: string;
  private index: SkillIndex;
  private readonly records = new Map<string, SkillRecord>();
  private readonly bodyStats = new Map<string, {
    tokens: number;
    fingerprint: string;
  }>();
  constructor(readonly config: AppConfig) {
    this.root = resolve(config.dataDir, "skills");
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, "index.json");
    this.index = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SkillIndex : { entries: {}, deleted: {}, published: {}, initialized: false };
    if (!this.index.initialized) {
      for (const item of builtinSkills)
        this.write(item.id, item.input, "builtin");
      this.index.initialized = true;
      this.saveIndex();
    }
  }
  private saveIndex(next = this.index): void {
    this.atomicJson(join(this.root, "index.json"), next);
    this.index = next;
  }
  private atomicJson(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  }
  get(id: string, revision?: number): SkillRecord | null {
    validateSkillId(id);
    const active = Object.hasOwn(this.index.entries, id) ? this.index.entries[id] : undefined;
    if (active == null)
      return null;
    const selected = revision ?? active;
    if (!Object.hasOwn(this.index.published, id) || !this.index.published[id]!.includes(selected))
      return null;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > active)
      return null;
    const path = join(this.root, id, String(selected), "version.json");
    const key = `${id}:${selected}`;
    let record = this.records.get(key);
    if (!record && existsSync(path)) {
      record = JSON.parse(readFileSync(path, "utf8")) as SkillRecord;
      this.records.set(key, record);
    }
    return record ? structuredClone(record) : null;
  }
  isVersionValid(id: string, revision: number): boolean { return revision > (Object.hasOwn(this.index.deleted, id) ? this.index.deleted[id]! : 0); }
  private stats(skill: SkillRecord): {
    tokens: number;
    fingerprint: string;
  } {
    const key = `${skill.id}:${skill.revision}`;
    let stats = this.bodyStats.get(key);
    if (!stats) {
      const body = parseSkillDocument(skill.document).body;
      stats = { tokens: estimateSkillTokens(skill.document), fingerprint: skillFingerprint(body) };
      this.bodyStats.set(key, stats);
    }
    return stats;
  }
  list(): SkillSummary[] { return Object.keys(this.index.entries).sort().map(id => this.summary(this.get(id)!)); }
  summary(skill: SkillRecord): SkillSummary {
    const { document, resources, ...metadata } = skill;
    const unavailableReason = !this.config.skills.enabled ? "技能总开关已关闭" : skill.userPolicy === "disabled" ? "用户已禁用" : skill.modelPaused ? "模型已暂停" : this.stats(skill).tokens > this.config.skills.maxBodyTokens ? "正文超过当前加载预算" : null;
    return { ...metadata, resourcePaths: Object.keys(resources).sort(), bodyTokens: this.stats(skill).tokens, effectiveAvailable: unavailableReason === null, unavailableReason };
  }
  history(id: string): SkillSummary[] {
    const current = this.get(id);
    if (!current)
      throw new SkillError("技能不存在。", 404);
    return Array.from({ length: current.revision }, (_, index) => this.get(id, current.revision - index)).filter((record): record is SkillRecord => record != null).map(record => this.summary(record));
  }
  write(id: string, input: SkillWriteInput, actor: SkillRecord["updatedBy"]): SkillRecord {
    validateSkillId(id);
    const current = this.get(id);
    if (input.expectedRevision !== (current?.revision ?? null))
      throw new SkillError("技能版本已变化，请刷新后重试。", 409);
    if (actor === "model") {
      if (!this.config.skills.enabled || !this.config.skills.modelMaintenanceEnabled)
        throw new SkillError("模型技能维护未启用。", 403);
      if (current && (current.userPolicy === "disabled" || !current.modelEditable))
        throw new SkillError("用户禁用或锁定的技能不能由模型修改。", 403);
      if (input.userPolicy !== (current?.userPolicy ?? "auto") || input.modelEditable !== (current?.modelEditable ?? true))
        throw new SkillError("模型不能修改用户策略或用户锁。", 403);
      if (!input.changeReason?.trim())
        throw new SkillError("自主维护必须说明依据和变更理由。");
    }
    const parsed = parseSkillDocument(input.document);
    validateSkillResources(input.resources);
    if (typeof input.modelEditable !== "boolean" || typeof input.modelPaused !== "boolean" || !["auto", "disabled"].includes(input.userPolicy))
      throw new SkillError("技能策略无效。");
    if (!Array.isArray(input.toolsetIds) || input.toolsetIds.some(id => !TOOLSET_DEFINITIONS.some(toolset => toolset.id === id)))
      throw new SkillError("绑定了未知工具集。");
    if (!current && this.list().length >= this.config.skills.maxCount)
      throw new SkillError("技能数量已达上限。");
    const fingerprint = skillFingerprint(parsed.body);
    for (const summary of this.list()) {
      if (summary.id === id)
        continue;
      const other = this.get(summary.id)!;
      if (other.name === parsed.name || this.stats(other).fingerprint === fingerprint)
        throw new SkillError("技能名称或正文与已有技能重复。", 409);
    }
    if (input.modelPaused && !input.modelPauseReason?.trim())
      throw new SkillError("暂停技能时必须填写原因。");
    let revision = Math.max(current?.revision ?? 0, (Object.hasOwn(this.index.deleted, id) ? this.index.deleted[id]! : 0)) + 1;
    while (existsSync(join(this.root, id, String(revision))))
      revision += 1;
    const next: SkillRecord = {
      id, revision,
      name: parsed.name, description: parsed.description, document: input.document, resources: structuredClone(input.resources), toolsetIds: [...new Set(input.toolsetIds)],
      userPolicy: input.userPolicy, modelEditable: input.modelEditable, modelPaused: input.modelPaused,
      modelPauseReason: input.modelPaused ? input.modelPauseReason!.trim() : null,
      changeReason: input.changeReason?.trim() || "用户更新", updatedAt: Date.now(), updatedBy: actor
    };
    // 不可变版本目录是单一内容真源；只有 index rename 后版本才对请求可见。
    const directory = join(this.root, id, String(next.revision));
    this.atomicJson(join(directory, "version.json"), next);
    writeFileSync(join(directory, "SKILL.md"), next.document, { mode: 0o600 });
    for (const [path, content] of Object.entries(next.resources)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content, { mode: 0o600 });
    }
    const index = structuredClone(this.index);
    index.entries[id] = next.revision;
    index.published[id] = [...(Object.hasOwn(index.published, id) ? index.published[id]! : []), next.revision];
    this.saveIndex(index);
    return structuredClone(next);
  }
  delete(id: string, expectedRevision: number): void {
    const current = this.get(id);
    if (!current)
      throw new SkillError("技能不存在。", 404);
    if (expectedRevision !== current.revision)
      throw new SkillError("技能版本已变化。", 409);
    const index = structuredClone(this.index);
    index.deleted[id] = current.revision;
    delete index.entries[id];
    this.saveIndex(index);
  }
  rollback(id: string, expectedRevision: number, revision: number): SkillRecord {
    const target = this.get(id, revision);
    if (!target)
      throw new SkillError("历史版本不存在。", 404);
    // 回滚正文和绑定，不通过旧版本解除当前用户策略。
    const current = this.get(id)!;
    return this.write(id, { ...target, userPolicy: current.userPolicy, modelEditable: current.modelEditable, expectedRevision, changeReason: `回滚到版本 ${revision}` }, "user");
  }
}
const stores = new WeakMap<AppConfig, SkillStore>();
export function getSkillStore(config: AppConfig): SkillStore {
  let store = stores.get(config);
  if (!store) {
    store = new SkillStore(config);
    stores.set(config, store);
  }
  return store;
}

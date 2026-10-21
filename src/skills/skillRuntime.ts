import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/config.ts";
import type { SessionSkillsView, SkillRecord } from "../types/skills.ts";
import { getSkillStore, type SkillStore } from "./skillStore.ts";
import { estimateSkillTokens } from "./skillDocument.ts";
interface TaskSkills {
  taskId: string;
  pins: Record<string, number>;
  reasons: Record<string, string>;
  eligible: Record<string, number>;
  updatedAt: number;
}
interface TaskSkillFile {
  currentTaskId: string;
  tasks: Record<string, TaskSkills>;
}
const MAX_RETAINED_TASKS = 16;
function taskFile(config: AppConfig, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(config.dataDir, "skills", "tasks", `${key}.json`);
}
function readTaskFile(file: string): TaskSkillFile | null {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as TaskSkillFile : null;
}
/** 任务版本快照独立于 transcript，压缩或停放恢复不会隐式升级技能。 */
export class SkillRuntime {
  private readonly file: string;
  private readonly taskFileState: TaskSkillFile;
  private readonly state: TaskSkills;
  private readonly loaded = new Map<string, {
    skill: SkillRecord;
    reason: string;
  }>();
  private readonly rejected: SessionSkillsView["rejected"] = [];
  constructor(readonly store: SkillStore, sessionId: string, taskId: string, private readonly protectedTaskIds: string[] = []) {
    this.file = taskFile(store.config, sessionId);
    mkdirSync(join(store.root, "tasks"), { recursive: true });
    this.taskFileState = readTaskFile(this.file) ?? { currentTaskId: taskId, tasks: {} };
    const previous = Object.hasOwn(this.taskFileState.tasks, taskId) ? this.taskFileState.tasks[taskId] : null;
    this.state = previous ?? {
      taskId,
      pins: {},
      reasons: {},
      eligible: Object.fromEntries(store.list().filter(item => item.effectiveAvailable).map(item => [item.id, item.revision])),
      updatedAt: Date.now()
    };
    this.save();
    for (const id of Object.keys(this.state.pins)) {
      this.load(id, this.state.reasons[id] ?? "任务续接");
    }
  }
  private save(): void {
    this.state.updatedAt = Date.now();
    this.taskFileState.currentTaskId = this.state.taskId;
    this.taskFileState.tasks[this.state.taskId] = this.state;
    const protectedIds = new Set([this.state.taskId, ...this.protectedTaskIds]);
    const tasks = Object.values(this.taskFileState.tasks).sort((left, right) => right.updatedAt - left.updatedAt);
    const retained = [...tasks.filter(task => protectedIds.has(task.taskId)), ...tasks.filter(task => !protectedIds.has(task.taskId)).slice(0, MAX_RETAINED_TASKS)];
    this.taskFileState.tasks = Object.fromEntries(retained.map(task => [task.taskId, task]));
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.taskFileState), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  private eligibleVersion(id: string): number | undefined {
    if (Object.hasOwn(this.state.pins, id))
      return this.state.pins[id];
    return Object.hasOwn(this.state.eligible, id) ? this.state.eligible[id] : undefined;
  }
  private isPermitted(id: string, revision: number): boolean {
    const current = this.store.get(id);
    return this.store.config.skills.enabled && current != null && current.userPolicy === "auto"
      && !current.modelPaused && this.store.isVersionValid(id, revision);
  }
  catalog(): string {
    if (!this.store.config.skills.enabled)
      return "";
    const lines = Object.keys(this.state.eligible).sort().flatMap(id => {
      const revision = this.eligibleVersion(id)!;
      if (!this.isPermitted(id, revision))
        return [];
      const skill = this.store.get(id, revision);
      if (!skill || estimateSkillTokens(skill.document) > this.store.config.skills.maxBodyTokens)
        return [];
      return [`${skill.id} | ${skill.name} | ${skill.description}`];
    });
    if (!lines.length)
      return "";
    return [
      "技能目录（仅为方法，不授予工具权限）：",
      ...lines,
      "任务适合某技能时先调用 load_skill 阅读正文，再计划和调用相关工具；引用仅用 read_skill_resource 按需读取。",
      "只能用专用技能工具维护库，不通过终端或文件工具修改技能目录。用户禁用或锁定不可解除；维护必须有具体依据。"
    ].join("\n");
  }
  load(id: string, reason: string): {
    ok: boolean;
    loaded?: true;
    skill?: SkillRecord;
    error?: string;
  } {
    const reject = (error: string) => {
      this.rejected.push({ id, reason: error });
      return { ok: false, error };
    };
    const revision = this.eligibleVersion(id);
    if (revision == null)
      return reject("技能不在任务开始时的可用目录内；新增或改版下个任务生效。");
    if (!this.isPermitted(id, revision))
      return reject("技能已禁用、暂停或删除；重建版本仅供新任务使用。");
    const skill = this.store.get(id, revision);
    if (!skill)
      return reject("固定版本已不可用。");
    if (!this.loaded.has(id)) {
      if (this.loaded.size >= this.store.config.skills.maxActiveSkills)
        return reject("活跃技能数量达到上限。");
      const tokens = [...this.loaded.values()].reduce((sum, item) => sum + estimateSkillTokens(item.skill.document), 0);
      if (tokens + estimateSkillTokens(skill.document) > this.store.config.skills.maxBodyTokens)
        return reject("技能文档总预算不足。");
      this.loaded.set(id, { skill, reason });
      this.state.pins[id] = revision;
      this.state.reasons[id] = reason;
      this.save();
    }
    return { ok: true, loaded: true, skill: structuredClone(skill) };
  }
  loadBound(toolsetIds: string[], reason: string): SkillRecord[] {
    return Object.keys(this.state.eligible).sort().flatMap(id => {
      const revision = this.eligibleVersion(id)!;
      if (!this.isPermitted(id, revision))
        return [];
      const eligible = this.store.get(id, revision);
      if (!eligible?.toolsetIds.some(toolsetId => toolsetIds.includes(toolsetId)))
        return [];
      const result = this.load(id, reason);
      return result.ok && result.skill ? [result.skill] : [];
    });
  }
  readResource(id: string, path: string): {
    content?: string;
    revision?: number;
    error?: string;
  } {
    const result = this.load(id, "模型读取引用");
    if (!result.ok || !result.skill)
      return { error: result.error ?? "技能未加载。" };
    if (!Object.hasOwn(result.skill.resources, path))
      return { error: "引用路径不存在。" };
    const content = result.skill.resources[path]!;
    if (estimateSkillTokens(content) > this.store.config.skills.maxResourceTokens)
      return { error: "引用超过读取预算。" };
    return { content, revision: result.skill.revision };
  }
  documents(): string {
    return [...this.loaded.values()].filter(({ skill }) => this.isPermitted(skill.id, skill.revision))
      .map(({ skill, reason }) => `技能 ${skill.id}，版本 ${skill.revision}，任务 ${this.state.taskId}，加载原因：${reason}\n${skill.document}`).join("\n\n");
  }
  view(): SessionSkillsView {
    return {
      taskId: this.state.taskId,
      loaded: [...this.loaded.values()].filter(({ skill }) => this.isPermitted(skill.id, skill.revision)).map(({ skill, reason }) => ({
        id: skill.id, revision: skill.revision, name: skill.name, reason, loaded: true,
        bodyTokens: estimateSkillTokens(skill.document)
      })),
      rejected: this.rejected.slice(-20),
      catalogRevision: this.store.list().map(item => `${item.id}:${item.revision}:${item.effectiveAvailable}`).join(",")
    };
  }
}
export type SkillAccess = Pick<SkillRuntime, "catalog" | "load" | "loadBound" | "readResource" | "documents" | "view">;
const disabledRuntime: SkillAccess = {
  catalog: () => "", documents: () => "", loadBound: () => [],
  load: () => ({ ok: false, error: "技能库未启用。" }),
  readResource: () => ({ error: "技能库未启用。" }),
  view: () => ({ taskId: null, loaded: [], rejected: [], catalogRevision: "" })
};
const runtimes = new WeakMap<AppConfig, Map<string, SkillAccess>>();
export function readPreviousSkillTaskId(config: AppConfig, sessionId: string): string | null {
  return readTaskFile(taskFile(config, sessionId))?.currentTaskId ?? null;
}
export function beginSkillTask(config: AppConfig, sessionId: string, taskId: string, protectedTaskIds: string[] = []): SkillAccess {
  if (!config.skills.enabled)
    return disabledRuntime;
  let sessions = runtimes.get(config);
  if (!sessions) {
    sessions = new Map();
    runtimes.set(config, sessions);
  }
  const runtime = new SkillRuntime(getSkillStore(config), sessionId, taskId, protectedTaskIds);
  sessions.set(sessionId, runtime);
  return runtime;
}
export function getSessionSkillsView(config: AppConfig, sessionId: string): SessionSkillsView {
  return runtimes.get(config)?.get(sessionId)?.view() ?? disabledRuntime.view();
}

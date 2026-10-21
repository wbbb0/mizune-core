import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/config.ts";
import type { SkillWriteInput } from "../types/skills.ts";
import { getSkillStore } from "./skillStore.ts";
import { validateSkillId } from "./skillDocument.ts";
export interface SkillDraft {
  id: string;
  input: SkillWriteInput;
}
function path(config: AppConfig, sessionId: string): string {
  return join(config.dataDir, "skills", "drafts", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
export function readSkillDraft(config: AppConfig, sessionId: string): SkillDraft | null {
  const file = path(config, sessionId);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as SkillDraft : null;
}
export function writeSkillDraft(config: AppConfig, sessionId: string, draft: SkillDraft): void {
  validateSkillId(draft.id);
  mkdirSync(join(config.dataDir, "skills", "drafts"), { recursive: true });
  writeFileSync(path(config, sessionId), JSON.stringify(draft), { mode: 0o600 });
}
export function startSkillDraft(config: AppConfig, sessionId: string, id?: string): SkillDraft {
  const store = getSkillStore(config);
  const selectedId = id ?? "new-skill";
  validateSkillId(selectedId);
  const current = store.get(selectedId);
  const draft: SkillDraft = { id: selectedId, input: current ? { ...current, expectedRevision: current.revision } : {
      expectedRevision: null, document: `---\nname: ${selectedId}\ndescription: 请填写技能适用场景。\n---\n# 技能\n请填写中文方法说明。\n`, resources: {}, toolsetIds: [], userPolicy: "auto", modelEditable: true, modelPaused: false
    } };
  writeSkillDraft(config, sessionId, draft);
  return draft;
}
export function cancelSkillDraft(config: AppConfig, sessionId: string): void {
  const file = path(config, sessionId);
  if (existsSync(file))
    unlinkSync(file);
}
export function confirmSkillDraft(config: AppConfig, sessionId: string): void {
  const draft = readSkillDraft(config, sessionId);
  if (!draft)
    throw new Error("没有技能草稿。");
  getSkillStore(config).write(draft.id, draft.input, "user");
  cancelSkillDraft(config, sessionId);
}
export function requireActiveSkillDraft(config: AppConfig, sessionId: string, operationMode: {
  kind: string;
  skillId?: string;
}): SkillDraft | null {
  if (operationMode.kind !== "skill_config")
    return null;
  const draft = readSkillDraft(config, sessionId);
  if (!draft || draft.id !== operationMode.skillId)
    throw new Error("当前技能草稿缺失或与配置流程不一致，请 .cancel 后重新 .config skill。");
  return draft;
}

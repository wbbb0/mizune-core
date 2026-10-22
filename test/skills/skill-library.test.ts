import { projectSkillObservations, skillObservation } from "../../src/skills/skillObservation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore, getSkillStore } from "../../src/skills/skillStore.ts";
import { SkillRuntime, beginSkillTask } from "../../src/skills/skillRuntime.ts";
import { parseSkillDocument } from "../../src/skills/skillDocument.ts";
import { startSkillDraft, readSkillDraft, cancelSkillDraft, confirmSkillDraft } from "../../src/skills/skillDrafts.ts";
import { skillToolHandlers, projectSkillForModel } from "../../src/llm/tools/runtime/skillTools.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";
import { resolveTurnPlannerRequirements } from "../../src/conversation/turnPlannerPolicy.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { SkillWriteInput } from "../../src/types/skills.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";

function fixture() {
  const config = createTestAppConfig({ dataDir: mkdtempSync(join(tmpdir(), "skill-test-")), localFiles: { enabled: true } });
  return { config, store: new SkillStore(config) };
}
function input(id = "alpha", revision: number | null = null, body = "这是中文技能正文，用来验证任务固定版本。"): SkillWriteInput {
  return { expectedRevision: revision, document: `---\nname: ${id}\ndescription: 用于验证技能行为。\n---\n${body}`, resources: {}, toolsetIds: ["shell_runtime"], userPolicy: "auto", modelEditable: true, modelPaused: false, changeReason: "根据当前任务验证维护行为" };
}
test("标准文档、引用路径、重复与数量校验", () => {
  const { config, store } = fixture();
  assert.throws(() => parseSkillDocument("缺少元数据"));
  assert.throws(() => parseSkillDocument("---\nname: example\ndescription: 示例\n---\nEnglish only"));
  store.write("alpha", input(), "user");
  assert.throws(() => store.write("beta", input("beta"), "user"), /重复/);
  assert.throws(() => store.write("unsafe", { ...input("unsafe"), resources: { "references/../escape.md": "内容" } }, "user"), /引用/);
  config.skills.maxCount = 2;
  assert.throws(() => store.write("beta", input("beta", null, "另一份中文正文"), "user"), /数量/);
});
test("revision冲突、历史与回滚始终创建新版本", () => {
  const { store } = fixture();
  store.write("alpha", input(), "user");
  store.write("alpha", input("alpha", 1, "更新后的中文正文"), "user");
  assert.throws(() => store.write("alpha", input("alpha", 1), "model"), /版本/);
  const rolled = store.rollback("alpha", 2, 1);
  assert.equal(rolled.revision, 3);
  assert.equal(store.history("alpha").length, 3);
  assert.equal(rolled.document, input().document);
});
test("用户锁、禁用及自主维护开关是模型硬权限", () => {
  const { config, store } = fixture();
  const locked = store.write("alpha", { ...input(), modelEditable: false }, "user");
  assert.throws(() => store.write("alpha", { ...input("alpha", locked.revision), modelEditable: true }, "model"), /锁定/);
  const disabled = store.write("alpha", { ...input("alpha", locked.revision), userPolicy: "disabled" }, "user");
  assert.throws(() => store.write("alpha", input("alpha", disabled.revision), "model"), /禁用/);
  config.skills.modelMaintenanceEnabled = false;
  assert.throws(() => store.write("beta", input("beta", null, "其他中文内容"), "model"), /维护未启用/);
});
test("任务固定版本、绑定编辑下任务生效、资源按需读取", () => {
  const { store } = fixture();
  store.write("alpha", { ...input(), resources: { "references/detail.md": "引用细节" } }, "user");
  const first = new SkillRuntime(store, "session", "task-one");
  store.write("alpha", { ...input("alpha", 1, "新版中文正文"), toolsetIds: ["web_research"] }, "user");
  assert.equal(first.loadBound(["web_research"], "网页需求").some(skill => skill.id === "alpha"), false);
  assert.equal(first.loadBound(["shell_runtime"], "终端需求")[0]?.revision, 1);
  const loaded = first.load("alpha", "主动加载").skill!;
  assert.equal(Object.hasOwn(projectSkillForModel(loaded), "resources"), false);
  assert.equal(first.readResource("alpha", "references/detail.md").content, "引用细节");
  const resumed = new SkillRuntime(store, "session", "task-one");
  assert.equal(resumed.load("alpha", "压缩后恢复").skill?.revision, 1);
  const next = new SkillRuntime(store, "session", "task-two");
  assert.equal(next.loadBound(["web_research"], "新任务").find(skill => skill.id === "alpha")?.revision, 2);
});
test("任务中新增、删除后同ID重建均不复活旧版本", () => {
  const { store } = fixture();
  store.write("alpha", input(), "user");
  const runtime = new SkillRuntime(store, "session", "task");
  runtime.load("alpha", "按需");
  store.write("beta", input("beta", null, "后来新增的中文正文"), "user");
  assert.equal(runtime.load("beta", "尝试加载").ok, false);
  store.delete("alpha", 1);
  store.write("alpha", input("alpha", null, "重建后的中文正文"), "user");
  assert.equal(runtime.load("alpha", "尝试恢复").ok, false);
  assert.doesNotMatch(runtime.documents(), /固定版本/);
  assert.equal(runtime.view().loaded.some(skill => skill.id === "alpha"), false);
  assert.doesNotMatch(runtime.catalog(), /alpha/);
});
test("用户禁用后所有新正文与引用请求立即拒绝", () => {
  const { store } = fixture();
  store.write("alpha", { ...input(), resources: { "references/detail.md": "引用细节" } }, "user");
  const runtime = new SkillRuntime(store, "session", "task");
  runtime.load("alpha", "按需");
  store.write("alpha", { ...input("alpha", 1), userPolicy: "disabled" }, "user");
  assert.equal(runtime.load("alpha", "按需").ok, false);
  assert.ok(runtime.readResource("alpha", "references/detail.md").error);
  assert.equal(runtime.documents(), "");
});
test("活跃数量与正文预算在实际加载时执行", () => {
  const { config, store } = fixture();
  store.write("alpha", input(), "user");
  config.skills.maxActiveSkills = 1;
  const runtime = new SkillRuntime(store, "session", "task");
  assert.equal(runtime.load("alpha", "按需").ok, true);
  assert.equal(runtime.load("web-research", "按需").ok, false);
});
test("原型键ID保持正常版本与任务针对此ID的隔离", () => {
  const { store } = fixture();
  const record = store.write("constructor", input("constructor"), "user");
  assert.equal(record.revision, 1);
  const runtime = new SkillRuntime(store, "session", "task");
  assert.equal(runtime.load("constructor", "按需").skill?.revision, 1);
  assert.equal(runtime.load("tostring", "按需").ok, false);
});
test("planner技能选择与工具all/planned独立，关闭及无候选不增加planner职责", () => {
  const { config } = fixture();
  const context = { canSkipReply: false, pendingWaitPasses: 0, availableToolsetCount: 10, availableSkillCount: 1 };
  for (const mode of ["all", "planned"] as const) {
    config.llm.turnPlanner.toolSelection = mode;
    config.skills.plannerSelectionEnabled = true;
    assert.equal(resolveTurnPlannerRequirements(config, context).skillSelection, true);
    config.skills.plannerSelectionEnabled = false;
    assert.equal(resolveTurnPlannerRequirements(config, context).skillSelection, false);
  }
  config.skills.plannerSelectionEnabled = true;
  assert.equal(resolveTurnPlannerRequirements(config, { ...context, availableSkillCount: 0 }).skillSelection, false);
});
test("config技能草稿暂停不触及正式库，取消与确认保持事务语义", async () => {
  const { config } = fixture();
  const store = getSkillStore(config);
  store.write("alpha", input(), "user");
  const context = { config, relationship: "owner", lastMessage: { sessionId: "session" }, sessionManager: { getOperationMode: () => ({ kind: "skill_config", skillId: "alpha" }) } } as unknown as BuiltinToolContext;
  startSkillDraft(config, "session", "alpha");
  await skillToolHandlers.set_skill_paused!({} as never, { id: "alpha", expectedRevision: 1, paused: true, reason: "根据错误暂停" }, context);
  assert.equal(store.get("alpha")?.modelPaused, false);
  assert.equal(readSkillDraft(config, "session")?.input.modelPaused, true);
  cancelSkillDraft(config, "session");
  assert.equal(store.get("alpha")?.revision, 1);
  startSkillDraft(config, "session", "alpha");
  await skillToolHandlers.set_skill_paused!({} as never, { id: "alpha", expectedRevision: 1, paused: true, reason: "根据错误暂停" }, context);
  confirmSkillDraft(config, "session");
  assert.equal(store.get("alpha")?.modelPaused, true);
  await assert.rejects(() => skillToolHandlers.save_skill!({} as never, { id: "alpha", ...input("alpha", 2) }, { ...context, relationship: "known" }), /owner/);
});
test("通用文件访问保护库、祖先和符号链接别名", async () => {
  const { config } = fixture();
  const files = new LocalFileService(config, config.dataDir);
  const root = join(config.dataDir, "skills");
  mkdirSync(root, { recursive: true });
  symlinkSync(root, join(config.dataDir, "alias"));
  assert.throws(() => files.resolvePath("skills/index.json"), /专用技能接口/);
  assert.throws(() => files.resolvePath("alias/new.md"), /专用技能接口/);
  await assert.rejects(() => files.deleteItem(config.dataDir), /专用技能接口/);
  await assert.rejects(() => files.moveItem(config.dataDir, `${config.dataDir}-other`), /专用技能接口/);
});


test("低预算内置技能不可加载但不阻断聊天，关闭总开关无持久化副作用", () => {
  const config = createTestAppConfig({ skills: { maxBodyTokens: 128, enabled: false } });
  assert.doesNotThrow(() => beginSkillTask(config, "session", "task"));
  assert.equal(existsSync(join(config.dataDir, "skills")), false);
  config.skills.enabled = true;
  const store = new SkillStore(config);
  assert.equal(store.list().find(skill => skill.id === "web-research")?.effectiveAvailable, false);
});
test("完整frontmatter计入实际加载预算，不能夹带任意超额metadata", () => {
  const { config, store } = fixture();
  const base = input();
  store.write("alpha", { ...base, document: base.document.replace("description:", `metadata: ${"x".repeat(5000)}\ndescription:`) }, "user");
  config.skills.maxBodyTokens = 128;
  assert.equal(new SkillRuntime(store, "session", "task").load("alpha", "按需").ok, false);
});
test("停放A/B/A恢复保留原固定版本", () => {
  const { store } = fixture();
  store.write("alpha", input(), "user");
  const first = new SkillRuntime(store, "session", "A");
  first.load("alpha", "A加载");
  store.write("alpha", input("alpha", 1, "更新后的中文正文"), "user");
  new SkillRuntime(store, "session", "B").load("alpha", "B加载");
  assert.equal(new SkillRuntime(store, "session", "A").load("alpha", "恢复A").skill?.revision, 1);
});
test("失效技能观察在下次请求撤销且工具call/result形状保留", () => {
  const { config } = fixture();
  const store = getSkillStore(config);
  const skill = store.write("alpha", input(), "user");
  const messages = [{ role: "tool" as const, tool_call_id: "call-1", content: skillObservation("load", [skill], { skill: projectSkillForModel(skill) }) }];
  assert.equal(projectSkillObservations(config, messages)[0]?.content, messages[0]?.content);
  store.write("alpha", { ...input("alpha", 1), userPolicy: "disabled" }, "user");
  const projected = projectSkillObservations(config, messages)[0]!;
  assert.equal(projected.tool_call_id, "call-1");
  assert.match(String(projected.content), /revoked/);
  assert.doesNotMatch(String(projected.content), /固定版本/);
});
test("索引提交失败不修改活跃内容，失败版本不进入历史", () => {
  const { store } = fixture();
  store.write("alpha", input(), "user");
  const blocked = join(store.root, `index.json.${process.pid}.tmp`);
  mkdirSync(blocked);
  assert.throws(() => store.write("alpha", input("alpha", 1, "失败版本的中文正文"), "user"));
  assert.equal(store.get("alpha")?.revision, 1);
  rmSync(blocked, { recursive: true });
  const next = store.write("alpha", input("alpha", 1, "成功版本的中文正文"), "user");
  assert.equal(next.revision, 3);
  assert.equal(store.get("alpha", 2), null);
  assert.deepEqual(store.history("alpha").map(skill => skill.revision), [3, 1]);
});
test("普通文件搜索跳过受保护技能子树且其他内容可搜索", async () => {
  const { config } = fixture();
  writeFileSync(join(config.dataDir, "note.txt"), "合法内容");
  const files = new LocalFileService(config, config.dataDir);
  assert.ok((await files.searchItems("note")).items.length > 0);
  assert.ok((await files.findText("合法内容")).matches.length > 0);
});
test("配置模式缺失草稿文件时维护工具不能落入正式库", async () => {
  const { config } = fixture();
  const store = getSkillStore(config);
  store.write("alpha", input(), "user");
  const context = { config, relationship: "owner", lastMessage: { sessionId: "missing" }, sessionManager: { getOperationMode: () => ({ kind: "skill_config", skillId: "alpha" }) } } as unknown as BuiltinToolContext;
  await assert.rejects(() => skillToolHandlers.set_skill_paused!({} as never, { id: "alpha", expectedRevision: 1, paused: true, reason: "测试暂停" }, context), /草稿缺失/);
  assert.equal(store.get("alpha")?.modelPaused, false);
});

test("task身份只按实际语义信号续接，活跃primary优先于压缩换题", async () => {
  const { resolveSkillTaskId } = await import("../../src/skills/skillTaskIdentity.ts");
  const planner = { replyDecision: "reply_small" as const, topicDecision: "continue_topic" as const, reason: "默认", requiredCapabilities: [], contextDependencies: [], recentDomainReuse: [], followupMode: "none" as const, toolsetIds: [] };
  const context = { sessionId: "session", primary: null, previousTaskId: "old", planner, explicitContinuation: false, startedAt: 10 };
  assert.equal(resolveSkillTaskId(context), "turn:session:10");
  assert.equal(resolveSkillTaskId({ ...context, planner: { ...planner, topicDecisionEvaluated: true } }), "old");
  assert.equal(resolveSkillTaskId({ ...context, explicitContinuation: true }), "old");
  assert.equal(resolveSkillTaskId({ ...context, planner: { ...planner, topicDecision: "new_topic", topicDecisionEvaluated: true }, primary: { taskId: "active", status: "active", objective: "原任务", done: [], next: [], blockers: [], importantToolRefs: [], createdAtMs: 1, updatedAtMs: 1 } }), "active");
});

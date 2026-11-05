import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDirectCommand, resolveDispatchableDirectCommand } from "../../src/app/messaging/directCommands.ts";
import { createDirectCommandFixture } from "../helpers/direct-command-fixtures.tsx";
import { readSkillDraft, writeSkillDraft, startSkillDraft } from "../../src/skills/skillDrafts.ts";
import { deleteSession, switchSessionMode } from "../../src/internalApi/application/basicAdminService.ts";
import { getSkillStore, SkillStore } from "../../src/skills/skillStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";
import { createInternalApiServices } from "../../src/internalApi/types.ts";
import { startInternalApi } from "../../src/internalApi/server.ts";
import { saveWebuiAuth } from "../../src/internalApi/auth/webuiAuthStore.ts";
import { hashPassword } from "../../src/internalApi/auth/webuiAuth.ts";
import type { ParsedDirectCommand } from "../../src/app/messaging/directCommands.ts";

function draftInput() {
  return { expectedRevision: null, document: "---\nname: admin-guide\ndescription: 管理验证技能。\n---\n这是一份用于确认草稿发布与接口保护的中文技能。", resources: {}, toolsetIds: ["time_utils"], userPolicy: "auto" as const, modelEditable: true, modelPaused: false };
}
test(".config skill 完整确认、取消、互斥与群聊权限", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "skill-command-"));
  const fixture = createDirectCommandFixture({ config: { dataDir } });
  const sessionId = "qqbot:p:owner";
  const send = (command: ParsedDirectCommand, relationship: "owner" | "known" = "owner") => fixture.handler({ command, sessionId, incomingMessage: { chatType: "private", userId: "owner", relationship } });
  assert.deepEqual(parseDirectCommand(".config skill admin-guide"), { name: "config", target: "skill", id: "admin-guide" });
  assert.equal(resolveDispatchableDirectCommand({ phase: "chat", setupState: "ready", chatType: "group", relationship: "known", isAtMentioned: true, text: ".config skill admin-guide" }), null);
  await send({ name: "config", target: "skill", id: "admin-guide" });
  const config = createTestAppConfig({ dataDir });
  assert.equal(readSkillDraft(config, sessionId)?.id, "admin-guide");
  await send({ name: "setup", target: "social" });
  assert.match(fixture.calls.at(-1)!.text, /当前配置草稿/);
  writeSkillDraft(config, sessionId, { id: "admin-guide", input: draftInput() });
  await send({ name: "cancel" });
  assert.equal(readSkillDraft(config, sessionId), null);
  assert.equal(new SkillStore(config).get("admin-guide"), null);
  await send({ name: "config", target: "skill", id: "admin-guide" });
  writeSkillDraft(config, sessionId, { id: "admin-guide", input: draftInput() });
  await send({ name: "confirm" });
  assert.equal(new SkillStore(config).get("admin-guide")?.revision, 1);
  assert.equal(readSkillDraft(config, sessionId), null);
  await send({ name: "config", target: "skill", id: "another-guide" }, "known");
  assert.equal(readSkillDraft(config, sessionId), null);
  assert.match(fixture.calls.at(-1)!.text, /只有 owner/);
});

test("真实管理路由受WebUI认证保护，revision并发、回滚及删除贯通", async () => {
  const deps = createInternalApiDeps();
  deps.config.internalApi.webui.enabled = true;
  deps.config.internalApi.webui.auth.enabled = true;
  deps.config.internalApi.webui.port = 0;
  mkdirSync(deps.config.dataDir, { recursive: true });
  await saveWebuiAuth(deps.config.dataDir, { passwordHash: hashPassword("skill-test-password"), passwordUpdatedAt: Date.now(), sessionVersion: 1, passkey: null });
  const server = await startInternalApi({ config: deps.config, logger: deps.logger, services: createInternalApiServices(deps) });
  try {
    assert.equal((await server.inject({ method: "GET", url: "/api/skills" })).statusCode, 401);
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: "skill-test-password" } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const headers = { cookie };
    const catalog = await server.inject({ method: "GET", url: "/api/skills", headers });
    assert.equal(catalog.statusCode, 200);
    assert.ok(catalog.json().toolsets.some((toolset: { id: string }) => toolset.id === "time_utils"));
    const first = await server.inject({ method: "PUT", url: "/api/skills/admin-guide", headers, payload: draftInput() });
    assert.equal(first.statusCode, 200);
    const updates = await Promise.all([1, 2].map(number => server.inject({ method: "PUT", url: "/api/skills/admin-guide", headers, payload: { ...draftInput(), expectedRevision: 1, changeReason: `并发修改${number}`, document: `${draftInput().document}\n修改${number}` } })));
    assert.deepEqual(updates.map(response => response.statusCode).sort(), [200, 409]);
    const history = await server.inject({ method: "GET", url: "/api/skills/admin-guide/history", headers });
    assert.equal(history.json().versions.length, 2);
    assert.equal(history.json().versions[0].document, undefined);
    const rollback = await server.inject({ method: "POST", url: "/api/skills/admin-guide/rollback", headers, payload: { expectedRevision: 2, revision: 1 } });
    assert.equal(rollback.statusCode, 200);
    assert.equal(rollback.json().skill.revision, 3);
    const deleted = await server.inject({ method: "DELETE", url: "/api/skills/admin-guide", headers, payload: { expectedRevision: 3 } });
    assert.equal(deleted.statusCode, 200);
    assert.equal((await server.inject({ method: "GET", url: "/api/skills/admin-guide", headers })).statusCode, 404);
  } finally {
    await server.close();
  }
});

test("群聊 owner 的技能配置被拒绝，非法 ID 反馈错误且不进入编辑", async () => {
  const config = createTestAppConfig();
  let operation = { kind: "normal" };
  const group = createDirectCommandFixture({
    config, session: { id: "qqbot:g:123", type: "group" },
    getOperationMode: () => operation,
    setOperationMode: (_id, value) => { operation = value as typeof operation; }
  });
  await group.handler({ command: { name: "config", target: "skill", id: "admin-guide" }, sessionId: "qqbot:g:123", incomingMessage: { chatType: "group", groupId: "123", userId: "owner", relationship: "owner" } });
  assert.match(group.calls.at(-1)!.text, /请在私聊中配置技能/);
  assert.equal(operation.kind, "normal");
  assert.equal(readSkillDraft(config, "qqbot:g:123"), null);
  const privateChat = createDirectCommandFixture({ config });
  await privateChat.handler({ command: { name: "config", target: "skill", id: "-bad-id" }, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
  assert.match(privateChat.calls.at(-1)!.text, /技能 ID 无效/);
  assert.equal(readSkillDraft(config, "qqbot:p:owner"), null);
});

test("开始、确认与取消技能草稿均中断响应；发布冲突保留草稿", async () => {
  const config = createTestAppConfig({ skills: { modelMaintenanceEnabled: false } });
  let interrupts = 0;
  const fixture = createDirectCommandFixture({ config, interruptResponse: () => { interrupts++; return {}; } });
  const sessionId = "qqbot:p:owner";
  const send = (command: ParsedDirectCommand) => fixture.handler({ command, sessionId, incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
  await send({ name: "config", target: "skill", id: "admin-guide" });
  assert.equal(interrupts, 1);
  writeSkillDraft(config, sessionId, { id: "admin-guide", input: draftInput() });
  await send({ name: "confirm" });
  assert.equal(interrupts, 2);
  assert.equal(new SkillStore(config).get("admin-guide")?.revision, 1);
  await send({ name: "config", target: "skill", id: "admin-guide" });
  await send({ name: "cancel" });
  assert.equal(interrupts, 4);
  assert.equal(readSkillDraft(config, sessionId), null);
  await send({ name: "config", target: "skill", id: "admin-guide" });
  getSkillStore(fixture.config).write("admin-guide", { ...draftInput(), expectedRevision: 1, document: draftInput().document + "其他入口已更新。" }, "user");
  await send({ name: "confirm" });
  assert.match(fixture.calls.at(-1)!.text, /版本已变化/);
  assert.ok(readSkillDraft(config, sessionId));
});

test("管理入口阻止未完成技能草稿的模式切换，会话删除清理草稿", async () => {
  const deps = createInternalApiDeps();
  const sessionId = deps.__state.sessions[0]!.id;
  const draft = startSkillDraft(deps.config, sessionId, "admin-guide");
  await assert.rejects(switchSessionMode(deps, sessionId, { modeId: "assistant" }), /技能配置草稿/);
  assert.equal(deps.sessionManager.getSession(sessionId).modeId, "rp_assistant");
  assert.deepEqual(readSkillDraft(deps.config, sessionId), draft);
  const result = await deleteSession(deps, sessionId);
  assert.equal(result.ok, true);
  assert.equal(readSkillDraft(deps.config, sessionId), null);
});

test("管理 API 模式切换等待持久化期间，新技能草稿不被角色初始化覆盖", async () => {
  const deps = createInternalApiDeps();
  const session = deps.__state.sessions[0]!;
  session.participantRef = { kind: "user", id: "owner" };
  const sessionId = session.id;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { entered = resolve; });
  deps.sessionPersistence.save = async () => { entered(); await waiting; };
  const services = createInternalApiServices(deps);
  const pending = switchSessionMode(services.basicRoutes.config, sessionId, { modeId: "assistant" });
  await saving;
  const draft = startSkillDraft(deps.config, sessionId, "admin-guide");
  deps.sessionManager.setOperationMode(sessionId, { kind: "skill_config", skillId: draft.id });
  release();
  await assert.rejects(pending, /技能配置草稿/);
  assert.equal(deps.sessionManager.getSession(sessionId).operationMode.kind, "skill_config");
  assert.deepEqual(readSkillDraft(deps.config, sessionId), draft);
});

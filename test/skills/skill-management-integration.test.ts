import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDirectCommand, resolveDispatchableDirectCommand } from "../../src/app/messaging/directCommands.ts";
import { createDirectCommandFixture } from "../helpers/direct-command-fixtures.tsx";
import { readSkillDraft, writeSkillDraft } from "../../src/skills/skillDrafts.ts";
import { SkillStore } from "../../src/skills/skillStore.ts";
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
  await send({ name: "setup", target: "rp" });
  assert.match(fixture.calls.at(-1)!.text, /当前技能草稿/);
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

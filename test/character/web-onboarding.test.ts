import test from "node:test";
import assert from "node:assert/strict";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { characterRepository } from "../../src/character/repository.ts";

test("新建未配置的 Web 会话立即进入第一阶段并排入一次模型引导，刷新不重复", async () => {
  const deps = createInternalApiDeps();
  deps.config = { ...deps.config, dataDir: createTestAppConfig().dataDir };
  let calls = 0, messages = 0;
  deps.flushSession = () => { calls++; };
  deps.sessionManager.appendSyntheticPendingMessage = () => { messages++; return {} as never; };
  const app = await createInternalApiApp(deps);
  try {
    const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { modeId: "stateful_rp" } });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.json().session.id;
    assert.equal(characterRepository(deps.config.dataDir).draft(id)?.stage, "persona");
    assert.equal(calls, 1); assert.equal(messages, 1);
    for (let i = 0; i < 2; i++) {
      const catalog = await app.inject({ method: "GET", url: `/api/sessions/${id}/character` });
      assert.equal(catalog.json().stage, "persona");
    }
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

for (const kind of ["group", "other_user", "owner"] as const) {
  test(`管理 API 切换模式仅在 owner 私聊初始化角色：${kind}`, async () => {
    const deps = createInternalApiDeps();
    deps.config = { ...deps.config, dataDir: createTestAppConfig().dataDir };
    const session = deps.__state.sessions[0]!;
    session.modeId = "assistant";
    if (kind === "group") {
      session.id = "qqbot:g:20001";
      session.type = "group";
      session.participantRef = { kind: "group", id: "20001" };
    } else if (kind === "owner") {
      session.participantRef = { kind: "user", id: "owner" };
    }
    let calls = 0, messages = 0;
    deps.flushSession = () => { calls++; };
    deps.sessionManager.appendSyntheticPendingMessage = () => { messages++; return {} as never; };
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}/mode`, payload: { modeId: "rp_assistant" } });
      assert.equal(response.statusCode, 200, response.body);
      const allowed = kind === "owner";
      assert.equal(characterRepository(deps.config.dataDir).draft(session.id)?.stage ?? null, allowed ? "persona" : null);
      assert.equal(session.operationMode.kind, allowed ? "character_config" : "normal");
      assert.equal(calls, allowed ? 1 : 0);
      assert.equal(messages, allowed ? 1 : 0);
    } finally { await app.close(); }
  });
}

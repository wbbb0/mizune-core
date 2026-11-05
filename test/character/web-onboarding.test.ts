import test from "node:test";
import assert from "node:assert/strict";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { characterRepository } from "../../src/character/repository.ts";
import { confirmCharacterDraftWithAssets } from "../../src/character/writes.ts";

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

test("HTTP 角色配置路由暴露前置已确认层 writable=false，支持按 itemId 单条读取并拒绝写入只读分块或非法 itemId", async () => {
  const deps = createInternalApiDeps();
  deps.config = { ...deps.config, dataDir: createTestAppConfig().dataDir };
  const session = deps.__state.sessions[0]!;
  session.modeId = "stateful_rp";
  session.participantRef = { kind: "user", id: "owner" };
  const store = characterRepository(deps.config.dataDir);
  const pDraft = store.begin(session.id, "persona", "setup", "stateful_rp");
  store.edit(session.id, "stateful_rp", "persona.name", "set", "小满", undefined, pDraft.id);
  store.confirm(session.id, "stateful_rp");
  const sDraft = store.begin(session.id, "social", "setup", "stateful_rp");
  store.edit(
    session.id,
    "stateful_rp",
    "social.referenceImages",
    "upsert",
    { id: "ref-http", fileId: "cf_http", label: "HTTP立绘", subject: null, description: "HTTP设定图描述" },
    "ref-http",
    sDraft.id
  );
  store.confirm(session.id, "stateful_rp");
  const eDraft = store.begin(session.id, "embodiment", "setup", "stateful_rp");

  const app = await createInternalApiApp(deps);
  try {
    const catalog = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/character` });
    assert.equal(catalog.statusCode, 200);
    const body = catalog.json();
    assert.equal(body.stage, "embodiment");
    const refMeta = body.sections.find((s: any) => s.id === "social.referenceImages");
    assert.ok(refMeta);
    assert.equal(refMeta.writable, false);
    const bodyMeta = body.sections.find((s: any) => s.id === "embodiment.wardrobe.items");
    assert.ok(bodyMeta);
    assert.equal(bodyMeta.writable, true);

    const single = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/character/section`,
      payload: { id: "social.referenceImages", itemId: "ref-http" }
    });
    assert.equal(single.statusCode, 200);
    assert.equal(single.json().value.id, "ref-http");
    assert.equal(single.json().writable, false);

    const invalidItemId = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/character/section`,
      payload: { id: "social.referenceImages", itemId: 123 }
    });
    assert.equal(invalidItemId.statusCode, 400);

    const readOnlyEdit = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/character/section`,
      payload: { id: "persona.name", action: "set", value: "篡改", draftId: eDraft.id }
    });
    assert.equal(readOnlyEdit.statusCode, 400);
    assert.match(readOnlyEdit.json().error, /只读/);
  } finally {
    await app.close();
  }
});

test("HTTP 分块编辑、Data character_profile 验证与保存、以及 .confirm 均走统一资产校验管道", async () => {
  const deps = createInternalApiDeps();
  deps.config = { ...deps.config, dataDir: createTestAppConfig().dataDir };
  const session = deps.__state.sessions[0]!;
  session.modeId = "stateful_rp";
  session.participantRef = { kind: "user", id: "owner" };
  const store = characterRepository(deps.config.dataDir);
  store.begin(session.id, "persona", "setup", "stateful_rp");
  store.confirm(session.id, "stateful_rp");
  const sDraft = store.begin(session.id, "social", "setup", "stateful_rp");

  const app = await createInternalApiApp(deps);
  try {
    // 1. HTTP 写入不存在的图片资产被拒绝
    const badHttpEdit = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/character/section`,
      payload: {
        id: "social.referenceImages",
        action: "upsert",
        draftId: sDraft.id,
        value: { fileId: "file_not_exists", label: "无效图", subject: null, description: "描述" }
      }
    });
    assert.equal(badHttpEdit.statusCode, 400);
    assert.match(badHttpEdit.json().error, /未找到静态图片资产/);

    // 2. HTTP 写入真实存在的静态图片资产 file_image_1 成功
    const okHttpEdit = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/character/section`,
      payload: {
        id: "social.referenceImages",
        action: "upsert",
        draftId: sDraft.id,
        value: { id: "ref_valid_1", fileId: "file_image_1", label: "有效立绘", subject: " 主角 ", description: "有效描述" }
      }
    });
    assert.equal(okHttpEdit.statusCode, 200, okHttpEdit.body);
    assert.equal(okHttpEdit.json().value[0].fileId, "file_image_1");
    assert.equal(okHttpEdit.json().value[0].subject, "主角");

    // 3. .confirm 确认时若草稿引用了已失效的资产则拒绝发布，有效资产则正常发布
    const confirmedStage = await confirmCharacterDraftWithAssets({
      dataDir: deps.config.dataDir,
      config: deps.config,
      chatFileStore: deps.chatFileStore,
      sessionId: session.id,
      modeId: "stateful_rp"
    });
    assert.equal(confirmedStage, "social");

    // 4. Data character_profile validate 与 patch 同样校验资产存在性及来源字段不可变
    const currentProfile = store.profile();
    const invalidAssetProfile = structuredClone(currentProfile);
    invalidAssetProfile.social.referenceImages = [
      ...invalidAssetProfile.social.referenceImages!,
      { id: "ref_bad_data", fileId: "file_unknown_999", label: "未知", subject: null, description: "描述" }
    ];
    const badValidate = await app.inject({
      method: "POST",
      url: "/api/data/registry/resources/character_profile/validate",
      payload: { value: invalidAssetProfile }
    });
    assert.equal(badValidate.statusCode, 400);
    assert.match(badValidate.json().error, /未找到静态图片资产/);

    const validPatchProfile = structuredClone(currentProfile);
    validPatchProfile.social.referenceImages![0]!.label = "Data更新标签";
    const okPatch = await app.inject({
      method: "PATCH",
      url: "/api/data/registry/resources/character_profile",
      payload: { value: validPatchProfile }
    });
    assert.equal(okPatch.statusCode, 200, okPatch.body);
    assert.equal(store.profile().social.referenceImages?.[0]?.label, "Data更新标签");
  } finally {
    await app.close();
  }
});

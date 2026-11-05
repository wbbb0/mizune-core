import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { characterRepository } from "../../src/character/repository.ts";
import { confirmCharacterDraftWithAssets, editCharacterSectionWithAssets } from "../../src/character/writes.ts";
import { executeCharacterSetupTool } from "../../src/character/setupToolExecution.ts";
import { importCharacterReference } from "../../src/character/referenceImages.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "character-write-"));
  const store = characterRepository(dataDir);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  store.begin("s", "persona", "setup", "stateful_rp");
  store.confirm("s", "stateful_rp");
  const draft = store.begin("s", "social", "config", "stateful_rp");
  store.edit("s", "stateful_rp", "social.referenceImages", "upsert", {
    id: "r", fileId: "file_ok", label: "原标签", subject: null, description: "原描述"
  }, undefined, draft.id);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let queries = 0;
  const chatFileStore = {
    async getFile() { if (++queries === 1) { entered(); await gate; } return { fileId: "file_ok", kind: "image" } as any; },
    async isFileAvailable() { return true; },
    async withRetainedFiles<T>(_ids: Iterable<string>, operation: () => Promise<T> | T): Promise<T> { return operation(); }
  };
  const controller = new AbortController();
  let modeId = "stateful_rp";
  const context = {
    config: createTestAppConfig({ dataDir }), relationship: "owner", lastMessage: { sessionId: "s" },
    sessionManager: { getSession: () => ({ modeId }), getOperationMode: () => ({ kind: "character_config", stage: "social" }) },
    abortSignal: controller.signal, chatFileStore
  } as unknown as BuiltinToolContext;
  const update = async (patch: Record<string, unknown>) => JSON.parse(await executeCharacterSetupTool(
    "setup_update_social_referenceImages", { itemId: "r", ...patch }, context, draft.id
  ));
  return { dataDir, store, draft, chatFileStore, release, started, controller, context, update, changeMode: () => { modeId = "assistant"; } };
}

test("异步局部更新不会覆盖期间成功保存的其他字段", async t => {
  const f = fixture(t);
  const pending = f.update({ description: "迟到描述" });
  await f.started;
  const labelResult = await f.update({ label: "最新标签" });
  assert.equal(labelResult.saved, true);
  f.release();
  const result = await pending;
  assert.equal(result.saved, false);
  assert.match(result.error, /变化/);
  const item = f.store.section("s", "stateful_rp", "social.referenceImages", "r").value;
  assert.equal(item.label, "最新标签");
  assert.equal(item.description, "原描述");
});

test("等待资产校验的条目修改不能恢复已删除条目", async t => {
  const f = fixture(t);
  const pending = f.update({ description: "迟到描述" });
  await f.started;
  await editCharacterSectionWithAssets({
    dataDir: f.dataDir, chatFileStore: f.chatFileStore, sessionId: "s", modeId: "stateful_rp",
    id: "social.referenceImages", action: "remove", itemId: "r", draftId: f.draft.id
  });
  f.release();
  assert.equal((await pending).saved, false);
  assert.deepEqual(f.store.section("s", "stateful_rp", "social.referenceImages").value, []);
});

for (const reason of ["abort", "mode"] as const) {
  test(`资产校验期间${reason === "abort" ? "取消生成" : "切换模式"}后不能写入`, async t => {
    const f = fixture(t);
    const before = f.store.draft("s");
    const pending = f.update({ description: "不应提交" });
    await f.started;
    if (reason === "abort") f.controller.abort(); else f.changeMode();
    f.release();
    assert.equal((await pending).saved, false);
    assert.deepEqual(f.store.draft("s"), before);
  });
}

test("正常局部更新保留未提供字段，且仓库 update 要求目标存在", async t => {
  const f = fixture(t);
  f.release();
  assert.equal((await f.update({ description: "新描述" })).saved, true);
  const item = f.store.section("s", "stateful_rp", "social.referenceImages", "r").value;
  assert.equal(item.label, "原标签");
  assert.equal(item.description, "新描述");
  assert.throws(() => f.store.edit("s", "stateful_rp", "social.referenceImages", "update", { label: "新标签" }, "absent", f.draft.id), /不存在/);
});

test("提交后条目被移除，导入回执仍使用事务快照且不恢复条目", async t => {
  const f = fixture(t);
  f.release();
  f.context.mediaVisionService = { async prepareFileForModel() {
    return { inputUrl: "data:image/png;base64,c3ludGhldGlj", kind: "image", animated: false };
  } } as unknown as BuiltinToolContext["mediaVisionService"];
  f.context.mediaInspectionService = {
    isEnabled: () => true,
    async inspectPreparedMedia() { return { ok: true, requestedCount: 1, results: [{
      mediaId: "file_ok", status: "answered", found: true, answer: "精读新描述",
      visibleContentSummary: null, nearMatches: [], confidenceNotes: [], rawAnswer: "{}",
      parseStatus: "parsed", schemaIssues: [], modelRef: "test", completionStatus: "completed"
    }] }; }
  } as unknown as BuiltinToolContext["mediaInspectionService"];
  let leases = 0;
  let committed = false;
  f.chatFileStore.withRetainedFiles = async <T>(_ids: Iterable<string>, operation: () => Promise<T> | T): Promise<T> => {
    const call = ++leases;
    const result = await operation();
    if (call === 2) {
      committed = f.store.section("s", "stateful_rp", "social.referenceImages", "r").value.description === "精读新描述";
      await editCharacterSectionWithAssets({ dataDir: f.dataDir, chatFileStore: f.chatFileStore,
        sessionId: "s", modeId: "stateful_rp", id: "social.referenceImages", action: "remove", itemId: "r", draftId: f.draft.id });
    }
    return result;
  };
  const receipt = JSON.parse(await importCharacterReference({ asset_ref: "file_ok", refresh: true }, f.context, f.draft.id));
  assert.equal(committed, true);
  assert.equal(receipt.saved, true);
  assert.equal(receipt.itemId, "r");
  assert.equal(receipt.description, "精读新描述");
  assert.deepEqual(f.store.section("s", "stateful_rp", "social.referenceImages").value, []);
});

for (const replaceDraft of [false, true]) {
  test(`确认资产校验期间${replaceDraft ? "取消重建" : "修改同一"}草稿，拒绝发布新内容`, async t => {
    const f = fixture(t);
    const initialProfile = f.store.profile();
    const pending = confirmCharacterDraftWithAssets({
      dataDir: f.dataDir, chatFileStore: f.chatFileStore, sessionId: "s", modeId: "stateful_rp"
    });
    const rejected = assert.rejects(pending, /草稿.*变化/);
    await f.started;
    if (replaceDraft) { f.store.cancel("s"); f.store.begin("s", "social", "config", "stateful_rp"); }
    const current = f.store.draft("s")!;
    const appearance = f.store.section("s", "stateful_rp", "social.appearance").value;
    f.store.edit("s", "stateful_rp", "social.appearance", "set", { ...appearance, overview: "后来的修改" }, undefined, current.id);
    f.release();
    await rejected;
    assert.deepEqual(f.store.profile(), initialProfile);
    assert.equal(f.store.draft("s")!.value.social.appearance.overview, "后来的修改");
  });
}

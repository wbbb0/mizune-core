import test from "node:test";
import assert from "node:assert/strict";
import { createSkillsState } from "../../../webui/src/composables/sections/skillsState.ts";
import { ApiError } from "../../../webui/src/api/client.ts";
import type { SkillCatalog, SkillRecord } from "../../../webui/src/api/skills.ts";

const record = (id: string, revision = 1): SkillRecord => ({ id, revision, name: id, description: "技能", document: "文档", resources: { "references/a.md": "资源" }, toolsetIds: [], userPolicy: "auto", modelEditable: true, modelPaused: true, modelPauseReason: "模型暂停", changeReason: "更新", updatedAt: 1, updatedBy: "user" });
const catalog: SkillCatalog = { skills: [], config: { enabled: true, modelMaintenanceEnabled: true, plannerSelectionEnabled: true, maxCount: 10, maxActiveSkills: 3, maxBodyTokens: 1000, maxResourceTokens: 1000 }, toolsets: [] };
function client() {
  return {
    list: async () => catalog,
    get: async (id: string, revision?: number) => ({ skill: record(id, revision) }),
    save: async (id: string, _revision: number | null, draft: unknown) => ({ skill: { ...record(id, 2), ...draft as object } }),
    remove: async (_id: string, _revision: number) => {},
    history: async () => ({ versions: [] }),
    rollback: async (id: string, _expectedRevision: number, _revision: number) => ({ skill: record(id, 3) })
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("skill directory is lazy and rapid selection ignores stale detail responses", async () => {
  const api = client();
  const first = deferred<{ skill: SkillRecord }>();
  let reads = 0;
  api.get = async (id) => { reads++; return id === "first" ? first.promise : { skill: record(id) }; };
  const state = createSkillsState(api);
  await state.refresh();
  assert.equal(reads, 0);
  const stale = state.select("first");
  await state.select("second");
  first.resolve({ skill: record("first") });
  await stale;
  assert.equal(state.record.value?.id, "second");
  assert.equal(state.loading.value, false);
});

test("save uses baseline revision and preserves independent user and model policies", async () => {
  const api = client();
  const calls: unknown[] = [];
  api.save = async (...args) => { calls.push(args); return { skill: { ...record(args[0], 2), ...args[2] as object } }; };
  const state = createSkillsState(api);
  await state.select("example");
  state.draft.value!.userPolicy = "disabled";
  state.draft.value!.modelEditable = false;
  await state.save();
  assert.equal((calls[0] as unknown[])[1], 1);
  assert.equal(state.record.value?.userPolicy, "disabled");
  assert.equal(state.record.value?.modelPaused, true);
  assert.equal(state.record.value?.modelPauseReason, "模型暂停");
  assert.equal(state.record.value?.modelEditable, false);
  assert.equal(state.dirty.value, false);
});

test("stale save and rollback retain draft and require reload before another mutation", async () => {
  const api = client();
  let writes = 0;
  api.save = async () => { writes++; throw new ApiError(409, "conflict"); };
  api.rollback = async () => { throw new ApiError(409, "conflict"); };
  const state = createSkillsState(api);
  await state.select("example");
  state.draft.value!.document = "未保存正文";
  await state.save();
  assert.equal(state.conflicted.value, true);
  assert.equal(state.draft.value?.document, "未保存正文");
  assert.equal(state.record.value?.revision, 1);
  await state.save();
  assert.equal(writes, 1);
  await state.select("example");
  state.draft.value!.document = "回滚前草稿";
  await state.rollback(1);
  assert.equal(state.conflicted.value, true);
  assert.equal(state.draft.value?.document, "回滚前草稿");
});

test("deleting selected skill clears editor and carries the current revision", async () => {
  const api = client();
  const calls: unknown[] = [];
  api.remove = async (...args) => { calls.push(args); };
  const state = createSkillsState(api);
  await state.select("example");
  await state.remove();
  assert.deepEqual(calls, [["example", 1]]);
  assert.equal(state.selectedId.value, null);
  assert.equal(state.draft.value, null);
});

test("leaving section while saving cannot repopulate old editor state", async () => {
  const api = client();
  const pending = deferred<{ skill: SkillRecord }>();
  api.save = async () => pending.promise;
  const state = createSkillsState(api);
  await state.select("example");
  const saving = state.save();
  state.resetState();
  pending.resolve({ skill: record("example", 2) });
  await saving;
  assert.equal(state.record.value, null);
  assert.equal(state.busy.value, false);
});

test("new skill template passes the actual parser and invalid IDs keep current draft", async () => {
  const { parseSkillDocument, validateSkillId } = await import("../../../src/skills/skillDocument.ts");
  const state = createSkillsState(client());
  assert.equal(state.create("alpha"), true);
  validateSkillId(state.selectedId.value!);
  assert.equal(parseSkillDocument(state.draft.value!.document).name, "alpha");
  assert.equal(state.create("Uppercase / invalid"), false);
  assert.equal(state.selectedId.value, "alpha");
  assert.match(state.error.value, /技能 ID/);
});

test("history previews keep the last requested version when responses arrive out of order", async () => {
  const api = client();
  const first = deferred<{ skill: SkillRecord }>();
  api.get = async (id, revision) => revision === 1 ? first.promise : { skill: record(id, revision ?? 3) };
  const state = createSkillsState(api);
  await state.select("example");
  const slow = state.inspect(1);
  await state.inspect(2);
  first.resolve({ skill: record("example", 1) });
  await slow;
  assert.equal(state.preview.value?.revision, 2);
});

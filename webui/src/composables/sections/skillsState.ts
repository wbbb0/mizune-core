import { computed, ref } from "vue";
import { ApiError } from "../../api/client.ts";
import { skillsApi, type SkillCatalog, type SkillDraft, type SkillRecord, type SkillSummary } from "../../api/skills.ts";

export function createSkillsState(client = skillsApi) {
  const catalog = ref<SkillCatalog | null>(null);
  const selectedId = ref<string | null>(null);
  const record = ref<SkillRecord | null>(null);
  const draft = ref<SkillDraft | null>(null);
  const versions = ref<SkillSummary[] | null>(null);
  const preview = ref<SkillRecord | null>(null);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref("");
  const conflicted = ref(false);
  let selectionSequence = 0;
  let catalogSequence = 0;
  let historySequence = 0;
  let previewSequence = 0;
  const dirty = computed(() => draft.value != null && (!record.value || JSON.stringify(draft.value) !== JSON.stringify(toDraft(record.value))));
  function fail(cause: unknown) {
    conflicted.value = cause instanceof ApiError && cause.status === 409;
    error.value = conflicted.value ? "技能已被其他操作修改。草稿已保留，请重新读取最新版本后再编辑。" : cause instanceof Error ? cause.message : String(cause);
  }
  function adopt(skill: SkillRecord) {
    ++historySequence; ++previewSequence;
    selectedId.value = skill.id;
    record.value = skill;
    draft.value = toDraft(skill);
    versions.value = null;
    preview.value = null;
    conflicted.value = false;
  }
  async function refresh() {
    const sequence = ++catalogSequence;
    try { const result = await client.list(); if (sequence === catalogSequence) catalog.value = result; }
    catch (cause) { if (sequence === catalogSequence) fail(cause); }
  }
  async function select(id: string) {
    if (busy.value) return;
    const sequence = ++selectionSequence;
    selectedId.value = id;
    record.value = null;
    draft.value = null;
    versions.value = null;
    preview.value = null;
    loading.value = true;
    error.value = "";
    conflicted.value = false;
    try { const result = await client.get(id); if (sequence === selectionSequence) adopt(result.skill); }
    catch (cause) { if (sequence === selectionSequence) fail(cause); }
    finally { if (sequence === selectionSequence) loading.value = false; }
  }
  function create(id: string) {
    if (busy.value) return false;
    id = id.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) { error.value = "技能 ID 必须为不超过64字符的小写字母、数字和连字符。"; return false; }
    if (catalog.value?.skills.some((item) => item.id === id)) { error.value = "该技能 ID 已存在，请选择现有技能。"; return false; }
    ++selectionSequence;
    selectedId.value = id.trim(); record.value = null; versions.value = null; preview.value = null; loading.value = false; error.value = ""; conflicted.value = false;
    draft.value = { document: `---\nname: ${id}\ndescription: 说明适用场景\n---\n\n# ${id}\n\n描述执行步骤。\n`, resources: {}, toolsetIds: [], userPolicy: "auto", modelEditable: true, modelPaused: false, modelPauseReason: null, changeReason: "用户创建" };
    return true;
  }
  async function mutate(operation: () => Promise<{ skill: SkillRecord } | void>) {
    if (busy.value) return;
    const sequence = selectionSequence;
    busy.value = true; error.value = "";
    try {
      const result = await operation();
      if (sequence !== selectionSequence) return;
      if (result) adopt(result.skill);
      else { selectedId.value = null; record.value = null; draft.value = null; versions.value = null; preview.value = null; }
      await refresh();
    } catch (cause) { if (sequence === selectionSequence) fail(cause); }
    finally { if (sequence === selectionSequence) busy.value = false; }
  }
  async function save() {
    if (!selectedId.value || !draft.value || conflicted.value) return;
    const value = JSON.parse(JSON.stringify(draft.value)) as SkillDraft;
    await mutate(() => client.save(selectedId.value!, record.value?.revision ?? null, value));
  }
  async function remove() { if (record.value) { const { id, revision } = record.value; await mutate(() => client.remove(id, revision)); } }
  async function rollback(revision: number) { if (record.value && !conflicted.value) { const current = record.value; await mutate(() => client.rollback(current.id, current.revision, revision)); } }
  async function history() {
    if (!record.value || busy.value) return;
    const sequence = selectionSequence; const request = ++historySequence; const id = record.value.id;
    error.value = "";
    try { const result = await client.history(id); if (sequence === selectionSequence && request === historySequence) versions.value = result.versions; }
    catch (cause) { if (sequence === selectionSequence && request === historySequence) fail(cause); }
  }
  async function inspect(revision: number) {
    if (!record.value) return;
    const sequence = selectionSequence; const request = ++previewSequence; const id = record.value.id;
    preview.value = null; error.value = "";
    try { const result = await client.get(id, revision); if (sequence === selectionSequence && request === previewSequence) preview.value = result.skill; }
    catch (cause) { if (sequence === selectionSequence && request === previewSequence) fail(cause); }
  }
  function resetState() {
    ++selectionSequence; ++catalogSequence;
    catalog.value = null; selectedId.value = null; record.value = null; draft.value = null; versions.value = null; preview.value = null; error.value = ""; conflicted.value = false; loading.value = false; busy.value = false;
  }
  return { catalog, selectedId, record, draft, versions, preview, loading, busy, error, conflicted, dirty, refresh, select, create, save, remove, rollback, history, inspect, resetState };
}
function toDraft(skill: SkillRecord): SkillDraft {
  return { document: skill.document, resources: { ...skill.resources }, toolsetIds: [...skill.toolsetIds], userPolicy: skill.userPolicy, modelEditable: skill.modelEditable, modelPaused: skill.modelPaused, modelPauseReason: skill.modelPauseReason, changeReason: skill.changeReason };
}

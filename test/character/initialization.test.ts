import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterRepository } from "../../src/character/repository.ts";
import { characterSections, emptyValue, getCharacterSection, validateJson } from "../../src/character/schemaCatalog.ts";
import { advanceCycle } from "../../src/character/cycle.ts";
import { emptyCharacter, emptyCharacterSession } from "../../src/character/model.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "character-test-"));
  const store = new CharacterRepository(dir); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
function confirmAll(store: CharacterRepository, session = "s") {
  for (const stage of ["persona", "social", "embodiment", "state"]) {
    assert.equal(store.ensureSetup(session, "stateful_rp")?.stage, stage);
    store.confirm(session, "stateful_rp");
  }
}
test("自然分块目录完整，nullable 机制仍是一块，不泄露其他层", t => {
  const store = fixture(t); const draft = store.begin("s", "persona", "setup", "stateful_rp");
  assert.equal(draft.stage, "persona");
  assert.deepEqual(store.sections("s", "stateful_rp").map(s => s.id), ["persona.name", "persona.personality", "persona.identitySummary", "persona.voiceTone"]);
  assert.ok(characterSections.some(s => s.id === "embodiment.physiology.menstrualCycle"));
  assert.throws(() => store.section("s", "stateful_rp", "social.identity"));
});
test("四阶段允许全部留空确认，新会话只需要动态状态", t => {
  const store = fixture(t); confirmAll(store);
  assert.equal(store.ensureSetup("s", "stateful_rp"), null);
  assert.equal(store.state("s").initialized, true);
  assert.equal(store.requiredStage("other", "stateful_rp"), "state");
  assert.equal(store.requiredStage("agent", "assistant"), null);
});
test("草稿不会提前发布，取消不改固定档案，过期工具调用不能写入新草稿", t => {
  const store = fixture(t), draft = store.begin("s", "persona", "setup", "assistant");
  store.edit("s", "assistant", "persona.name", "set", "角色", undefined, draft.id);
  assert.equal(store.profile().persona.name, null);
  store.cancel("s"); store.begin("s", "persona", "setup", "assistant");
  assert.throws(() => store.edit("s", "assistant", "persona.name", "set", "旧写入", undefined, draft.id));
  assert.equal(store.profile().persona.name, null);
});
test("填写严格校验，不允许任意路径和未知字段，普通游玩不可写固定信息", t => {
  const store = fixture(t); confirmAll(store);
  assert.throws(() => store.edit("s", "stateful_rp", "persona.name", "set", "改名"));
  assert.throws(() => store.edit("s", "stateful_rp", "__proto__.x", "set", true));
  assert.throws(() => store.edit("s", "stateful_rp", "session.simulation.scene", "set", { unknown: true }));
});
test("两个会话并发确认全局档案时拒绝覆盖，动态状态隔离", t => {
  const store = fixture(t); const a = store.begin("a", "persona", "setup", "assistant");
  store.begin("b", "persona", "setup", "assistant");
  store.edit("a", "assistant", "persona.name", "set", "新名字", undefined, a.id); store.confirm("a", "assistant");
  assert.throws(() => store.confirm("b", "assistant"), /其他会话/);
  assert.equal(store.state("a").social.currentMood, null);
});
test("引导投递按草稿 ID 确认，重新进入产生新引导", t => {
  const store = fixture(t); store.ensureSetup("s", "assistant");
  const draft = store.draft("s")!;
  assert.equal(store.markIntroductionDelivered("s", "stale"), false);
  assert.equal(store.markIntroductionDelivered("s", draft.id), true);
  assert.equal(store.markIntroductionDelivered("s", draft.id), false);
  store.cancel("s"); store.ensureSetup("s", "assistant");
  assert.equal(store.markIntroductionDelivered("s", draft.id), false);
  assert.equal(store.draft("s")!.introduction, "pending");
});
test("代码周期按日历推进，读档不重新随机，跨周期不漏结算", () => {
  const profile = emptyCharacter(), state = emptyCharacterSession();
  profile.embodiment.physiology.menstrualCycle = { mode: "standard", reason: null, parameters: { cycleDays: 28, maxVariationDays: 2, durationDays: 5 }, narrativeRules: null };
  state.simulation.clock = { currentIso: "2026-01-01T00:00:00Z", timezone: "UTC" };
  state.simulation.body.activePhysiology.menstrualCycle = { lastStartDate: "2026-01-01", nextStartDate: null, currentEndDate: null, active: false, discomfortNote: null };
  let draws = 0; const draw = () => { draws++; return 2; };
  advanceCycle(profile, state, draw); assert.equal(draws, 1); assert.equal(state.simulation.body.activePhysiology.menstrualCycle.active, true);
  const restored = JSON.parse(JSON.stringify(state)); advanceCycle(profile, restored, draw); assert.equal(draws, 1);
  restored.simulation.clock.currentIso = "2026-03-05T00:00:00Z"; advanceCycle(profile, restored, draw);
  assert.equal(draws, 3); assert.equal(restored.simulation.body.activePhysiology.menstrualCycle.lastStartDate, "2026-03-02");
  assert.equal(restored.events.filter((event: { kind: string }) => event.kind === "cycle_started").length, 2);
});
test("缺日期不启动，关闭机制清空活动状态，参数范围校验", () => {
  const p = emptyCharacter(), s = emptyCharacterSession();
  p.embodiment.physiology.menstrualCycle = { mode: "standard", parameters: { cycleDays: 28, maxVariationDays: 0, durationDays: 5 } };
  advanceCycle(p, s); assert.equal(s.simulation.body.activePhysiology.menstrualCycle, null);
  p.embodiment.physiology.menstrualCycle.parameters.durationDays = 29; assert.throws(() => advanceCycle(p, s));
  p.embodiment.physiology.menstrualCycle.mode = "disabled"; advanceCycle(p, s); assert.equal(s.simulation.body.activePhysiology.menstrualCycle, null);
});
test("衣柜按单物品编辑，实例复制定义，不受全局模板后续删除影响", t => {
  const store = fixture(t);
  for (const stage of ["persona", "social"]) { store.ensureSetup("s", "stateful_rp"); store.confirm("s", "stateful_rp"); }
  const d = store.ensureSetup("s", "stateful_rp")!;
  const section = getCharacterSection("embodiment.wardrobe.items"); const item = emptyValue(section.schema.items); item.name = "外套"; item.quantity = 1;
  store.edit("s", "stateful_rp", section.id, "upsert", item, "coat", d.id); store.confirm("s", "stateful_rp");
  store.ensureSetup("s", "stateful_rp"); store.confirm("s", "stateful_rp");
  const config = store.begin("s", "embodiment", "config", "stateful_rp"); store.edit("s", "stateful_rp", section.id, "remove", undefined, "coat", config.id); store.confirm("s", "stateful_rp");
  assert.equal(store.profile().embodiment.wardrobe.items.length, 0);
  assert.equal(store.state("s").simulation.wardrobe.instances[0].definition.name, "外套");
});

test("周期日期校正重算派生字段，普通动态编辑不能直接制造周期事件", t => {
  const store = fixture(t); confirmAll(store);
  const draft = store.begin("s", "state", "config", "stateful_rp");
  const id = "session.simulation.body.activePhysiology.menstrualCycle";
  const value = { lastStartDate: "2026-01-01", nextStartDate: null, currentEndDate: null, active: false, discomfortNote: null };
  store.edit("s", "stateful_rp", id, "set", value, undefined, draft.id); store.confirm("s", "stateful_rp");
  assert.throws(() => store.edit("s", "stateful_rp", id, "set", { ...value, active: true }), /代码控制/);
  assert.throws(() => store.edit("s", "stateful_rp", id, "set", { ...value, lastStartDate: "2026-01-02" }), /校正/);
});

test("普通游玩不能通过清空时钟绕过倒退和维护计时器保护，配置仍可留空", t => {
  const store = fixture(t); confirmAll(store);
  const id = "session.simulation.clock", clock = store.state("s").simulation.clock;
  for (const value of [null, { ...clock, currentIso: null }, { ...clock, currentIso: "" }]) {
    assert.throws(() => store.edit("s", "stateful_rp", id, "set", value), /清空游戏时钟/);
  }
  assert.throws(() => store.edit("s", "stateful_rp", id, "set", { ...clock, currentIso: "2000-01-01T00:00:00Z" }), /倒退/);
  const draft = store.begin("s", "state", "config", "stateful_rp");
  store.edit("s", "stateful_rp", id, "skip", undefined, undefined, draft.id);
  store.confirm("s", "stateful_rp");
  assert.equal(store.state("s").simulation.clock, null);
  assert.throws(() => store.edit("s", "stateful_rp", id, "set", { ...clock, minutesSinceLastMindTick: 999 }), /维护计时器/);
});

test("非负状态指标拒绝负数，情绪效价保留有符号范围", t => {
  const store = fixture(t); confirmAll(store);
  assert.throws(() => store.edit("s", "stateful_rp", "session.simulation.body.vitals", "set", { ...store.state("s").simulation.body.vitals, energy: -1 }), /格式不正确/);
  const emotions = getCharacterSection("session.simulation.mind.emotions").schema;
  validateJson(emotions.properties.valence, -100, "valence");
  assert.throws(() => validateJson(emotions.properties.valence, -101, "valence"));
});

test("缩短周期参数仍保留当前结束日期，不提前开启重叠周期", () => {
  const profile = emptyCharacter(), state = emptyCharacterSession();
  profile.embodiment.physiology.menstrualCycle = { mode: "standard", parameters: { cycleDays: 28, maxVariationDays: 0, durationDays: 20 } };
  state.simulation.clock = { currentIso: "2026-01-02T00:00:00Z", timezone: "UTC" };
  state.simulation.body.activePhysiology.menstrualCycle = { lastStartDate: "2026-01-01", nextStartDate: null, currentEndDate: null, active: false };
  advanceCycle(profile, state);
  profile.embodiment.physiology.menstrualCycle.parameters = { cycleDays: 7, maxVariationDays: 0, durationDays: 3 };
  advanceCycle(profile, state);
  assert.equal(state.simulation.body.activePhysiology.menstrualCycle.nextStartDate, "2026-01-21");
  state.simulation.clock.currentIso = "2026-01-08T00:00:00Z";
  advanceCycle(profile, state);
  assert.equal(state.simulation.body.activePhysiology.menstrualCycle.currentEndDate, "2026-01-21");
  assert.equal(state.events.length, 0);
  state.simulation.clock.currentIso = "2026-01-21T00:00:00Z";
  advanceCycle(profile, state);
  assert.deepEqual(state.events.map(event => event.kind), ["cycle_ended", "cycle_started"]);
});

test("Data 发布固定档案只确认改动层，拒绝元数据篡改并使旧聊天草稿过期", t => {
  const store = fixture(t);
  store.begin("chat", "persona", "setup", "assistant");
  const candidate = store.profile();
  candidate.persona.name = "测试名字";
  const oldRevision = candidate.revision;
  const saved = store.saveProfile(candidate);
  assert.deepEqual(saved.confirmed, ["persona"]);
  assert.notEqual(saved.revision, oldRevision);
  assert.equal(store.requiredStage("new", "stateful_rp"), "social");
  assert.throws(() => store.confirm("chat", "assistant"), /其他会话/);
  assert.throws(() => store.saveProfile(candidate), /其他保存/);
  const tampered = store.profile(); tampered.confirmed.push("embodiment");
  assert.throws(() => store.saveProfile(tampered), /确认状态/);
  const extra = { ...store.profile(), unexpected: true };
  assert.throws(() => store.saveProfile(extra), /未知字段/);
});

test("Data 验证不发布，固定跨字段校验失败不改变档案和已有动态状态", t => {
  const store = fixture(t); confirmAll(store);
  const before = store.profile(), state = store.state("s");
  const next = store.profile(); next.persona.name = "草稿名字";
  store.validateProfile(next);
  assert.deepEqual(store.profile(), before);
  next.embodiment.wardrobe.outfits.push({ id: "outfit", name: null, itemIds: ["missing"], occasionTags: [], notes: null });
  assert.throws(() => store.saveProfile(next), /引用不存在/);
  assert.deepEqual(store.profile(), before);
  assert.deepEqual(store.state("s"), state);
  next.embodiment.wardrobe.outfits = [];
  store.saveProfile(next);
  assert.deepEqual(store.state("s"), state);
});

test("配置阶段统一允许只读已确认的前置固定设定，拒绝修改或跳过只读分块，未确认或后续阶段仍不可访问", t => {
  const store = fixture(t);
  const personaDraft = store.begin("s", "persona", "setup", "stateful_rp");
  store.edit("s", "stateful_rp", "persona.name", "set", "小满", undefined, personaDraft.id);
  store.confirm("s", "stateful_rp");

  const socialDraft = store.begin("s", "social", "setup", "stateful_rp");
  const socialSections = store.sections("s", "stateful_rp");
  const personaNameInSocial = socialSections.find(s => s.id === "persona.name");
  assert.ok(personaNameInSocial);
  assert.equal(personaNameInSocial.writable, false);
  assert.equal(personaNameInSocial.touched, false);
  assert.equal(store.section("s", "stateful_rp", "persona.name").value, "小满");
  assert.equal(store.section("s", "stateful_rp", "persona.name").writable, false);
  assert.throws(() => store.edit("s", "stateful_rp", "persona.name", "set", "篡改", undefined, socialDraft.id), /只读/);
  assert.throws(() => store.skipDraftSection("s", "stateful_rp", "persona.name", socialDraft.id), /只读/);
  assert.throws(() => store.section("s", "stateful_rp", "embodiment.body"));

  store.edit(
    "s",
    "stateful_rp",
    "social.referenceImages",
    "upsert",
    { id: "ref-1", fileId: "cf_01", label: "主立绘", subject: "  小满  ", description: "黑发少女，白衬衫与深蓝百褶裙。" },
    "ref-1",
    socialDraft.id
  );
  store.confirm("s", "stateful_rp");

  const embodimentDraft = store.begin("s", "embodiment", "setup", "stateful_rp");
  const refSection = store.section("s", "stateful_rp", "social.referenceImages");
  assert.equal(refSection.writable, false);
  assert.equal(refSection.value.length, 1);
  assert.equal(refSection.value[0].subject, "小满");
  const singleItem = store.section("s", "stateful_rp", "social.referenceImages", "ref-1");
  assert.equal(singleItem.writable, false);
  assert.equal(singleItem.value.id, "ref-1");
  assert.equal(singleItem.value.fileId, "cf_01");
  assert.throws(() => store.section("s", "stateful_rp", "social.referenceImages", 123), /itemId/);
  assert.throws(() => store.section("s", "stateful_rp", "social.referenceImages", "missing-id"), /未找到条目/);
  assert.throws(() => store.section("s", "stateful_rp", "persona.name", "ref-1"), /集合/);
  assert.throws(() => store.edit("s", "stateful_rp", "social.referenceImages", "remove", undefined, "ref-1", embodimentDraft.id), /只读/);
});

test("social.referenceImages 缺省归一化、唯一性、不可变来源字段与 referencedFileIds 枚举", t => {
  const store = fixture(t);
  store.begin("s", "persona", "setup", "stateful_rp");
  store.confirm("s", "stateful_rp");

  const socialDraft = store.begin("s", "social", "setup", "stateful_rp");
  assert.deepEqual(store.section("s", "stateful_rp", "social.referenceImages").value, []);
  store.edit(
    "s",
    "stateful_rp",
    "social.referenceImages",
    "upsert",
    { id: "ref-1", fileId: "cf_main", label: "整图设定", subject: "   ", description: "立绘详细描述" },
    "ref-1",
    socialDraft.id
  );
  const draftItems = store.section("s", "stateful_rp", "social.referenceImages").value;
  assert.equal(draftItems[0].subject, null);
  assert.deepEqual([...store.referencedFileIds()], ["cf_main"]);

  // 同一 (fileId, subject) 重复应被拒绝
  assert.throws(
    () =>
      store.edit(
        "s",
        "stateful_rp",
        "social.referenceImages",
        "upsert",
        { id: "ref-2", fileId: "cf_main", label: "重复整图", subject: null, description: "另一段描述" },
        "ref-2",
        socialDraft.id
      ),
    /不能重复/
  );

  // 同一 fileId 不同 subject 允许共存
  store.edit(
    "s",
    "stateful_rp",
    "social.referenceImages",
    "upsert",
    { id: "ref-2", fileId: "cf_main", label: "右侧角色", subject: "右侧角色", description: "右侧角色外观描述" },
    "ref-2",
    socialDraft.id
  );

  // 已存在条目不可修改 fileId 或 subject
  assert.throws(
    () =>
      store.edit(
        "s",
        "stateful_rp",
        "social.referenceImages",
        "upsert",
        { id: "ref-1", fileId: "cf_other", label: "整图设定", subject: null, description: "立绘详细描述" },
        "ref-1",
        socialDraft.id
      ),
    /不可修改/
  );
  assert.throws(
    () =>
      store.edit(
        "s",
        "stateful_rp",
        "social.referenceImages",
        "upsert",
        { id: "ref-1", fileId: "cf_main", label: "整图设定", subject: "新主体", description: "立绘详细描述" },
        "ref-1",
        socialDraft.id
      ),
    /不可修改/
  );

  // 允许修改 label 与 description
  store.edit(
    "s",
    "stateful_rp",
    "social.referenceImages",
    "upsert",
    { id: "ref-1", fileId: "cf_main", label: "更新后的标题", subject: null, description: "更新后的详细描述" },
    "ref-1",
    socialDraft.id
  );
  store.confirm("s", "stateful_rp");
  assert.deepEqual([...store.referencedFileIds()], ["cf_main"]);

  // 另一会话草稿中的参考图也纳入 referencedFileIds
  const otherDraft = store.begin("other", "social", "config", "stateful_rp");
  store.edit(
    "other",
    "stateful_rp",
    "social.referenceImages",
    "upsert",
    { id: "ref-3", fileId: "cf_draft_only", label: "草稿参考图", subject: null, description: "草稿描述" },
    "ref-3",
    otherDraft.id
  );
  assert.deepEqual([...store.referencedFileIds()].sort(), ["cf_draft_only", "cf_main"]);
  store.cancel("other");
  assert.deepEqual([...store.referencedFileIds()], ["cf_main"]);

  // Data validateProfile 归一化缺失 referenceImages 并拒绝非法非数组值或篡改已有条目的 fileId/subject
  const legacyCandidate = store.profile();
  delete (legacyCandidate.social as Record<string, unknown>).referenceImages;
  const normalized = store.validateProfile(legacyCandidate);
  assert.deepEqual(normalized.social.referenceImages, []);

  for (const invalidValue of [null, 123, "{}"]) {
    const bad = store.profile();
    (bad.social as Record<string, unknown>).referenceImages = invalidValue;
    assert.throws(() => store.validateProfile(bad), /格式不正确/);
  }

  // 父节点为 null 时不能被 normalizeProfileDefaults 静默改写为空对象
  const nullWardrobe = store.profile();
  (nullWardrobe.embodiment as Record<string, unknown>).wardrobe = null;
  assert.throws(() => store.validateProfile(nullWardrobe), /格式不正确/);

  // 非字符串 itemId 应被拒绝，不退化为全量读取
  assert.throws(() => store.section("s", "rp_assistant", "social.referenceImages", 123), /itemId/);

  const mutatedSource = store.profile();
  mutatedSource.social.referenceImages[0].fileId = "cf_hijack";
  assert.throws(() => store.validateProfile(mutatedSource), /不可修改/);
});

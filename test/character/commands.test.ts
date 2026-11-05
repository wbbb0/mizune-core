import test from "node:test";
import assert from "node:assert/strict";
import { createDirectCommandFixture } from "../helpers/direct-command-fixtures.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { characterRepository } from "../../src/character/repository.ts";
import type { ParsedDirectCommand } from "../../src/app/messaging/directCommands.ts";
import { characterPrompt } from "../../src/character/prompt.ts";
import { getCharacterSection } from "../../src/character/schemaCatalog.ts";
import { stageSetupBindings } from "../../src/character/setupEditing.ts";

test("真实命令链四阶段确认，每阶段仅一次引导，保留历史且允许空白", async () => {
  const config = createTestAppConfig(); const store = characterRepository(config.dataDir);
  let guides = 0, clears = 0;
  const f = createDirectCommandFixture({ config: { dataDir: config.dataDir }, session: { modeId: "stateful_rp" }, flushSession() { guides++; }, clearSession() { clears++; } });
  const send = (command: ParsedDirectCommand) => f.handler({ command, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
  await send({ name: "setup", target: "persona" });
  assert.equal(guides, 1);
  for (const stage of ["persona", "social", "embodiment", "state"]) {
    assert.equal(store.draft("qqbot:p:owner")?.stage, stage);
    await send({ name: "confirm" });
  }
  assert.equal(guides, 4); assert.equal(clears, 0); assert.equal(store.state("qqbot:p:owner").initialized, true);
  await send({ name: "confirm" }); assert.equal(guides, 4);
});
test("同一档案的各模式只能读取自己的层，配置提示不包含整份 Schema", () => {
  const config = createTestAppConfig(), store = characterRepository(config.dataDir);
  for (let i = 0; i < 4; i++) { store.ensureSetup("s", "stateful_rp"); store.confirm("s", "stateful_rp"); }
  const assistant = characterPrompt(config.dataDir, "s", "assistant").join("\n");
  const social = characterPrompt(config.dataDir, "s", "rp_assistant").join("\n");
  const sim = characterPrompt(config.dataDir, "s", "stateful_rp").join("\n");
  assert.doesNotMatch(assistant, /embodiment|physiology|participantRelationships/);
  assert.match(social, /social/); assert.doesNotMatch(social, /menstrualCycle/); assert.match(sim, /menstrualCycle/);
  store.begin("s", "embodiment", "config", "stateful_rp");
  assert.match(characterPrompt(config.dataDir, "s", "stateful_rp").join("\n"), /直接在参数顶层传要改的业务字段/);
});


test("已有角色草稿不能被 Scenario 或技能配置覆盖，包括操作标记缺失时", async () => {
  for (const missingMarker of [false, true]) {
    const config = createTestAppConfig();
    const store = characterRepository(config.dataDir);
    let operation: unknown = { kind: "normal" };
    const f = createDirectCommandFixture({
      config: { dataDir: config.dataDir }, session: { modeId: "stateful_rp" },
      getOperationMode: () => operation,
      setOperationMode: (_id, mode) => { operation = mode; }
    });
    const send = (command: ParsedDirectCommand) => f.handler({ command, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
    await send({ name: "setup", target: "persona" });
    const draft = store.draft("qqbot:p:owner")!;
    if (missingMarker) operation = { kind: "normal" };
    const before = structuredClone(operation);
    for (const command of [{ name: "setup", target: "scenario" }, { name: "config", target: "scenario" }, { name: "config", target: "skill" }] as ParsedDirectCommand[]) {
      await send(command);
      assert.deepEqual(operation, before);
      assert.equal(store.draft("qqbot:p:owner")?.id, draft.id);
      assert.match(f.calls.at(-1)!.text, /请先确认或取消/);
    }
  }
});

test("characterPrompt 在普通游玩与配置阶段投影 social.referenceImages 轻量索引且不改写内存对象，包含中文参考图指引", () => {
  const config = createTestAppConfig();
  const store = characterRepository(config.dataDir);
  store.ensureSetup("s", "stateful_rp");
  store.confirm("s", "stateful_rp"); // persona 确认
  store.ensureSetup("s", "stateful_rp"); // 进入 social
  store.edit("s", "stateful_rp", "social.referenceImages", "upsert", {
    fileId: "cf_ref_100",
    label: "日常立绘",
    subject: "小满",
    description: "一段非常冗长的角色设定图视觉描述文本_不应进入常驻Prompt"
  }, undefined, store.draft("s")?.id);
  store.confirm("s", "stateful_rp"); // social 确认
  store.ensureSetup("s", "stateful_rp"); // 进入 embodiment

  // 1. embodiment 配置阶段的“已确认的社交设定”仅保留 { id, fileId, label, subject }，不包含长 description，且含中文读取指引
  const embodimentDraftPrompt = characterPrompt(config.dataDir, "s", "stateful_rp").join("\n");
  assert.match(embodimentDraftPrompt, /cf_ref_100/);
  assert.match(embodimentDraftPrompt, /日常立绘/);
  assert.doesNotMatch(embodimentDraftPrompt, /一段非常冗长的角色设定图视觉描述文本_不应进入常驻Prompt/);
  assert.match(embodimentDraftPrompt, /read_character_section 读取 social\.referenceImages/);

  store.confirm("s", "stateful_rp"); // embodiment 确认
  store.ensureSetup("s", "stateful_rp"); // 进入 state
  store.confirm("s", "stateful_rp"); // state 确认 -> 普通游玩

  // 2. 普通游玩阶段的 social 仅保留轻量索引，不包含长 description，且含按需读取与生图/看图传 fileId 指引
  const normalPlayPrompt = characterPrompt(config.dataDir, "s", "stateful_rp").join("\n");
  assert.match(normalPlayPrompt, /cf_ref_100/);
  assert.doesNotMatch(normalPlayPrompt, /一段非常冗长的角色设定图视觉描述文本_不应进入常驻Prompt/);
  assert.match(normalPlayPrompt, /read_character_section/);
  assert.match(normalPlayPrompt, /generate_image/);
  assert.match(normalPlayPrompt, /asset_media_inspect/);

  // 3. social 配置阶段包含 import_character_reference 中文指引
  store.begin("s", "social", "config", "stateful_rp");
  const socialDraftPrompt = characterPrompt(config.dataDir, "s", "stateful_rp").join("\n");
  assert.match(socialDraftPrompt, /import_character_reference/);
  const appearanceFields = getCharacterSection("social.appearance").schema.properties;
  const mentionedAppearanceFields = [...socialDraftPrompt.matchAll(/social\.appearance\.([A-Za-z]+)/g)].map(match => match[1]!);
  assert.ok(mentionedAppearanceFields.length >= 2);
  assert.ok(mentionedAppearanceFields.every(field => Object.hasOwn(appearanceFields, field)));
  const socialTools = stageSetupBindings("social", store.draft("s")!.id);
  const mentionedSetupTools = [...socialDraftPrompt.matchAll(/\bsetup_[a-zA-Z0-9_]+\b/g)].map(match => match[0]);
  assert.ok(mentionedSetupTools.length >= 2);
  const availableNames = new Set(socialTools.map(tool => tool.definition.function.name));
  assert.ok(mentionedSetupTools.every(name => availableNames.has(name)));
  for (const action of ["update", "remove"]) {
    const tool = socialTools.find(tool => tool.sectionId === "social.referenceImages" && tool.action === action)!;
    assert.ok(socialDraftPrompt.includes(tool.definition.function.name));
  }

  // 4. 仓库中的正式 profile.social.referenceImages 未被原地改写，仍保留完整 description
  const persisted = store.profile().social.referenceImages;
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.description, "一段非常冗长的角色设定图视觉描述文本_不应进入常驻Prompt");
});

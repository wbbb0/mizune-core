import test from "node:test";
import assert from "node:assert/strict";
import { createDirectCommandFixture } from "../helpers/direct-command-fixtures.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { characterRepository } from "../../src/character/repository.ts";
import type { ParsedDirectCommand } from "../../src/app/messaging/directCommands.ts";
import { characterPrompt } from "../../src/character/prompt.ts";

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

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LlmClient } from "../../src/llm/llmClient.ts";
import { StatefulRpPostTurnMaintainer, StatefulRpStateStore, createInitialStatefulRpSessionState } from "../../src/modes/statefulRp/index.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function fixture(t: TestContext, generate: (system: string) => Promise<string>) {
  const dir = await mkdtemp(join(tmpdir(), "rp-maintenance-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = createTestAppConfig(), logger = createSilentLogger();
  const store = new StatefulRpStateStore(dir, config, logger);
  for (let i = 0; i < 4; i++) { store.characters.ensureSetup("session", "stateful_rp"); store.characters.confirm("session", "stateful_rp"); }
  const state = (await store.get("session"))!;
  const client = { generate: async (input: { messages: Array<{ content: string }> }) => ({ text: await generate(input.messages[0]!.content) }) } as unknown as LlmClient;
  const maintainer = new StatefulRpPostTurnMaintainer(config, client, store, logger);
  const input = { sessionId: "session", userText: "测试输入", assistantText: "测试回复", personaName: "测试角色", clockBeforeTurnIso: state.simulation.clock.currentIso };
  return { config, store, state, maintainer, input };
}
const timeResult = JSON.stringify({ elapsedMinutes: 2 });
for (const mutation of ["edit", "reset", "delete", "restore"] as const) {
  test(`维护期间 ${mutation} 后不能被旧结果覆盖或复活`, async t => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(t, async system => { if (system.includes("只估计")) { entered(); await barrier; return timeResult; } return '{"edits":[]}'; });
    const task = f.maintainer.runPostTurn(f.input); await started;
    if (mutation === "delete") await f.store.delete("session");
    else if (mutation === "reset") await f.store.write("session", createInitialStatefulRpSessionState());
    else if (mutation === "restore") await f.store.write("session", f.state);
    else f.store.characters.edit("session", "stateful_rp", "session.social.currentMood", "set", "手动修改");
    const expected = await f.store.get("session"); release();
    assert.equal(await task, null); assert.deepEqual(await f.store.get("session"), expected);
  });
}
test("维护失败不推进时间、不清零计时器，下轮可以重试", async t => {
  const f = await fixture(t, async () => '{"unexpected":true}');
  assert.equal(await f.maintainer.runPostTurn(f.input), null);
  assert.deepEqual(await f.store.get("session"), f.state);
});
test("未初始化或已删除的会话不自动初始化、不调用模型", async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return timeResult; });
  await f.store.write("session", createInitialStatefulRpSessionState());
  assert.equal(await f.maintainer.runPostTurn(f.input), null);
  await f.store.delete("session"); assert.equal(await f.maintainer.runPostTurn(f.input), null); assert.equal(calls, 0);
});
test("取消或过期世代不能提交后置结果", async t => {
  const f = await fixture(t, async system => system.includes("只估计") ? timeResult : '{"edits":[]}');
  assert.equal(await f.maintainer.runPostTurn({ ...f.input, isCurrent: () => false }), null);
  assert.deepEqual(await f.store.get("session"), f.state);
});
test("维护器不能通过返回其他分块修改周期或固定档案", async t => {
  const f = await fixture(t, async system => system.includes("只估计") ? '{"elapsedMinutes":30}' : '{"edits":[{"id":"persona.name","value":"越权"}]}');
  assert.equal(await f.maintainer.runPostTurn(f.input), null); assert.deepEqual(await f.store.get("session"), f.state);
});
test("后置维护器传入模型的角色档案对 social.referenceImages 做轻量投影，剥离长 description 且不修改原档案", async t => {
  const dir = await mkdtemp(join(tmpdir(), "rp-maintenance-projection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = createTestAppConfig(), logger = createSilentLogger();
  const store = new StatefulRpStateStore(dir, config, logger);
  store.characters.ensureSetup("session", "stateful_rp");
  store.characters.confirm("session", "stateful_rp"); // persona
  store.characters.ensureSetup("session", "stateful_rp"); // social
  store.characters.edit("session", "stateful_rp", "social.referenceImages", "upsert", {
    id: "ref_1",
    fileId: "cf_ref_maint",
    label: "正视图",
    subject: "主角",
    description: "后置维护器不应携带的超长视觉特征描述_SECRET_LONG_DESC"
  }, "ref_1", store.characters.draft("session")?.id);
  store.characters.confirm("session", "stateful_rp"); // social
  store.characters.ensureSetup("session", "stateful_rp"); // embodiment
  store.characters.confirm("session", "stateful_rp"); // embodiment
  store.characters.ensureSetup("session", "stateful_rp"); // state
  store.characters.confirm("session", "stateful_rp"); // state -> normal
  const state = (await store.get("session"))!;
  const capturedPayloads: string[] = [];
  const client = {
    generate: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const userMsg = input.messages.find(m => m.role === "user")?.content ?? "";
      capturedPayloads.push(userMsg);
      const sysMsg = input.messages[0]!.content;
      return { text: sysMsg.includes("只估计") ? '{"elapsedMinutes":60}' : '{"edits":[]}' };
    }
  } as unknown as LlmClient;
  const maintainer = new StatefulRpPostTurnMaintainer(config, client, store, logger);
  const res = await maintainer.runPostTurn({
    sessionId: "session",
    userText: "推进一小时",
    assistantText: "好的",
    personaName: "测试角色",
    clockBeforeTurnIso: state.simulation.clock.currentIso
  });
  assert.ok(res);
  assert.ok(capturedPayloads.length >= 1);
  for (const payload of capturedPayloads) {
    assert.doesNotMatch(payload, /后置维护器不应携带的超长视觉特征描述_SECRET_LONG_DESC/);
    const parsed = JSON.parse(payload);
    assert.deepEqual(parsed.character.social.referenceImages, [{
      id: "ref_1",
      fileId: "cf_ref_maint",
      label: "正视图",
      subject: "主角"
    }]);
  }
  assert.equal(
    store.characters.profile().social.referenceImages[0]!.description,
    "后置维护器不应携带的超长视觉特征描述_SECRET_LONG_DESC"
  );
});

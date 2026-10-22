import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSessionModes, requireSessionModeDefinition } from "../../src/modes/registry.ts";
import { resolveAutoActivatedToolsets } from "../../src/app/generation/toolsetAutoActivation.ts";
import {
  applyDeterministicTimeTick,
  buildOutfitSignature,
  buildStatefulRpPlannerSignalLine,
  buildStatefulRpStateLines,
  createInitialStatefulRpSessionState,
  StatefulRpPostTurnMaintainer,
  StatefulRpStateStore
} from "../../src/modes/statefulRp/index.ts";
import { buildUserBatchContent } from "../../src/llm/prompts/trigger-batch.prompt.ts";
import { analyzeBuiltinToolConcurrency } from "../../src/llm/tools/toolConcurrency.ts";
import { resolveDispatchableDirectCommand } from "../../src/app/messaging/directCommands.ts";
import { safeLogEvents } from "../../src/logging/safeLogEvents.ts";
import { createDirectCommandFixture } from "../helpers/direct-command-fixtures.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("stateful_rp mode definition reuses Persona + RpProfile and auto-activates stateful_rp_state toolset", () => {
  const modes = listSessionModes();
  assert.ok(modes.some((mode) => mode.id === "stateful_rp"));
  assert.ok(!modes.some((mode) => (mode.id as string) === "girl_sim"));

  const def = requireSessionModeDefinition("stateful_rp");
  assert.equal(def.profileAccess.persona, true);
  assert.equal(def.profileAccess.modeProfile, "rp");
  assert.ok(def.toolsets.some((item) => item.toolsetId === "stateful_rp_state" && item.defaultEnabled));

  const autoToolsets = resolveAutoActivatedToolsets({
    modeId: "stateful_rp",
    availableToolsets: [
      { id: "rp_control", title: "RP 控制", description: "", toolNames: [] },
      { id: "stateful_rp_state", title: "沉浸状态", description: "", toolNames: [] },
      { id: "context_memory", title: "长期记忆", description: "", toolNames: [] }
    ],
    batchMessages: [],
    recentMessages: []
  });
  assert.ok(autoToolsets.toolsetIds.includes("stateful_rp_state"));
});

test("StatefulRpStateStore persists state in sessions.sqlite and deterministic time tick updates clothing & cycle", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stateful-rp-store-test-"));
  const logger = createSilentLogger();
  const config = createTestAppConfig();
  const store = new StatefulRpStateStore(dataDir, config, logger);

  try {
    await store.init();
    const initial = await store.ensure("session-1", {
      startClockIso: "2026-05-16T14:00:00+08:00"
    });
    assert.equal(initial.initialized, false);
    assert.equal(initial.clock.currentIso, "2026-05-16T14:00:00+08:00");

    const ticked = applyDeterministicTimeTick(initial, {
      elapsedMinutes: 45,
      activityKind: "walking",
      isSeparated: false
    });
    assert.equal(ticked.nextState.clock.currentIso, "2026-05-16T14:45:00+08:00");
    assert.equal(ticked.nextState.clock.minutesSinceLastEmbodimentTick, 45);
    assert.equal(ticked.nextState.clock.minutesSinceLastMindTick, 45);

    const hosiery = ticked.nextState.embodiment.outfit.items.find((item) => item.slot === "hosiery");
    assert.ok(hosiery);
    assert.equal(hosiery.wornMinutes, 225);
    assert.ok(hosiery.wetness > 0);
    assert.ok(hosiery.odorIntensity > 0);

    await store.write("session-1", ticked.nextState);
    const loaded = await store.get("session-1");
    assert.ok(loaded);
    assert.equal(loaded.clock.currentIso, "2026-05-16T14:45:00+08:00");

    const listed = await store.listRows({ filters: { sessionId: "session-1" } });
    assert.equal(listed.total, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("buildStatefulRpStateLines, buildStatefulRpPlannerSignalLine, and # OOC prefix protocol work as expected", () => {
  const state = createInitialStatefulRpSessionState({
    sessionId: "s-rp",
    startClockIso: "2026-05-16T18:30:00+08:00"
  });
  state.initialized = true;
  state.embodiment.partSensations.thighs_legs = {
    sensation: "丝袜在大腿内侧因微汗有些黏腻紧贴",
    appearanceNote: "袜口边缘有浅浅勒痕",
    scentNote: "温热微酸的汗意混着淡香",
    sensitivity: 65,
    salience: 72
  };

  const lines = buildStatefulRpStateLines(state);
  assert.ok(lines.some((line) => line.includes("大腿与腿部") && line.includes("黏腻紧贴")));

  const signal = buildStatefulRpPlannerSignalLine(state, "# 把时间推进到晚上九点刚洗完澡");
  assert.ok(signal.includes("场外指令=是(#开头)"));
  assert.ok(signal.includes("最高体感显著度=72"));

  const batchParts = buildUserBatchContent(
    [
      {
        userId: "u1",
        senderName: "玩家",
        text: "# 把场景改到雨夜的出租屋客厅",
        timestampMs: Date.now(),
        images: [],
        imageIds: [],
        emojiIds: [],
        emojiSources: [],
        audioIds: [],
        audioSources: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        mentionedSelf: false
      },
      {
        userId: "u1",
        senderName: "玩家",
        text: "**",
        timestampMs: Date.now(),
        images: [],
        imageIds: [],
        emojiIds: [],
        emojiSources: [],
        audioIds: [],
        audioSources: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        mentionedSelf: false
      }
    ],
    {
      sessionId: "private:u1",
      modeId: "stateful_rp",
      currentTriggerUserId: "u1",
      currentTriggerSenderName: "玩家"
    }
  );
  const batchPrompt = batchParts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  assert.ok(batchPrompt.includes("场外指令：把场景改到雨夜的出租屋客厅"));
  assert.ok(batchPrompt.includes("顺势推进互动：对方请你在合理范围内顺势带出双方互动的下一小步，但不要代替对方扮演或替对方说话。"));
});

test("StatefulRpPostTurnMaintainer executes split passes based on 30-minute threshold", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stateful-rp-maintainer-test-"));
  const logger = createSilentLogger();
  const config = createTestAppConfig();
  const store = new StatefulRpStateStore(dataDir, config, logger);
  await store.init();

  const initial = await store.ensure("s-maint", {
    startClockIso: "2026-05-16T14:00:00+08:00"
  });
  const calls: string[] = [];

  const fakeLlmClient = {
    async generate(req: { messages: Array<{ role: string; content: string }> }) {
      const sys = req.messages[0]?.content ?? "";
      if (sys.includes("后置时间与活动判定器")) {
        calls.push("time_and_activity");
        return {
          text: JSON.stringify({
            elapsedMinutes: 35,
            activityKind: "walking",
            isSeparated: false,
            reason: "两人在街上散步交谈了半个多小时"
          })
        };
      }
      if (sys.includes("服饰物理与分部位感官维护器")) {
        calls.push("embodiment_sensory");
        return {
          text: JSON.stringify({
            itemUpdates: [
              {
                id: "hosiery-default",
                wetness: 42,
                odorIntensity: 35,
                odorNote: "久穿行走后的温热汗味",
                comfort: 55
              }
            ],
            overallImpact: "连裤丝袜在室外步行后变得微潮黏腻",
            observableAppearance: ["额角有细密汗珠", "步伐略显拘谨"],
            partSensations: {
              thighs_legs: {
                sensation: "丝袜贴在大腿内侧有些潮热黏腻",
                appearanceNote: "",
                scentNote: "温热汗意",
                sensitivity: 60,
                salience: 68
              }
            }
          })
        };
      }
      if (sys.includes("心理转化与关系余韵维护器")) {
        calls.push("mind_and_relation");
        return {
          text: JSON.stringify({
            surfaceVsInner: {
              surfaceDemeanor: "故作轻松地看着橱窗",
              innerMonologue: "丝袜里出汗好难受，希望他别靠太近闻到味道",
              tension: 65
            },
            desire: {
              shame: 55,
              arousal: 20,
              longing: 30,
              frustration: 35,
              focus: "腿部与足部的黏腻感"
            },
            intrusiveThoughts: ["想找个借口去洗手间整理一下丝袜"],
            intentions: [
              {
                goal: "提议去前面的咖啡馆坐下休息并借机去洗手间",
                reason: "连裤袜出汗黏腻不舒服",
                priority: 4
              }
            ]
          })
        };
      }
      return { text: "{}" };
    }
  } as any;

  const maintainer = new StatefulRpPostTurnMaintainer(config, fakeLlmClient, store, logger);

  try {
    const updated = await maintainer.runPostTurn({
      sessionId: "s-maint",
      userText: "* 和她一起沿着商业街走了半个多小时",
      assistantText: "“今天稍微有点热呢……”她轻轻扇了扇风。",
      personaName: "苏晚",
      clockBeforeTurnIso: initial.clock.currentIso,
      outfitSignatureBeforeTurn: buildOutfitSignature(initial)
    });

    assert.ok(updated);
    assert.deepEqual(calls, ["time_and_activity", "embodiment_sensory", "mind_and_relation"]);
    assert.equal(updated.clock.currentIso, "2026-05-16T14:35:00+08:00");
    assert.equal(updated.clock.minutesSinceLastEmbodimentTick, 0);
    assert.equal(updated.clock.minutesSinceLastMindTick, 0);
    assert.equal(updated.embodiment.partSensations.thighs_legs.salience, 68);
    assert.equal(updated.mind.surfaceVsInner.tension, 65);
    assert.equal(updated.mind.intentions[0]?.goal, "提议去前面的咖啡馆坐下休息并借机去洗手间");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("stateful_rp tool concurrency, safe log events, and .reset command support", async () => {
  assert.ok(safeLogEvents.has("stateful_rp_post_turn_maintained"));
  assert.ok(safeLogEvents.has("stateful_rp_reset_by_command"));

  const inspectEffect = analyzeBuiltinToolConcurrency({
    id: "c1",
    type: "function",
    function: { name: "stateful_rp_inspect", arguments: "{}" }
  });
  assert.deepEqual(inspectEffect, {
    kind: "parallel",
    reads: ["stateful_rp_state:*"],
    writes: []
  });

  for (const writeTool of [
    "stateful_rp_init",
    "stateful_rp_update_embodiment",
    "stateful_rp_update_mind_and_relation",
    "stateful_rp_update_scene"
  ]) {
    const effect = analyzeBuiltinToolConcurrency({
      id: `c-${writeTool}`,
      type: "function",
      function: { name: writeTool, arguments: "{}" }
    });
    assert.deepEqual(effect, {
      kind: "parallel",
      reads: [],
      writes: ["stateful_rp_state:*"]
    });
  }

  const resetInStatefulRp = resolveDispatchableDirectCommand({
    phase: "chat",
    setupState: "ready",
    chatType: "private",
    relationship: "owner",
    sessionModeId: "stateful_rp",
    text: ".reset"
  });
  assert.deepEqual(resetInStatefulRp, { name: "reset" });

  const resetInRpAssistant = resolveDispatchableDirectCommand({
    phase: "chat",
    setupState: "ready",
    chatType: "private",
    relationship: "owner",
    sessionModeId: "rp_assistant",
    text: ".reset"
  });
  assert.equal(resetInRpAssistant?.name, "unknown");

  const dataDir = await mkdtemp(join(tmpdir(), "stateful-rp-reset-test-"));
  const logger = createSilentLogger();
  const config = createTestAppConfig({ dataDir });
  const store = new StatefulRpStateStore(dataDir, config, logger);
  await store.init();
  try {
    await store.update("qqbot:p:owner", (cur) => ({
      ...cur,
      initialized: true,
      world: { ...cur.world, currentLocation: "商业街" }
    }));
    let cleared = false;
    const fixture = createDirectCommandFixture({
      config: { dataDir },
      session: { modeId: "stateful_rp" },
      statefulRpStateStore: store,
      clearSession: () => {
        cleared = true;
      }
    });
    await fixture.handler({
      command: { name: "reset" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });
    assert.equal(cleared, true);
    const afterReset = await store.get("qqbot:p:owner");
    assert.ok(afterReset);
    assert.equal(afterReset.initialized, false);
    assert.match(fixture.calls.at(-1)?.text ?? "", /角色与场景状态已重置/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

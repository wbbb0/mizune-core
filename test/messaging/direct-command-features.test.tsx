import test from "node:test";
import assert from "node:assert/strict";
import {
  canExecuteDirectCommand,
  parseDirectCommand,
  resolveDispatchableDirectCommand
} from "../../src/app/messaging/directCommands.ts";
import {
  resolvePostRouterSetupDecision,
  resolvePreRouterSetupDecision
} from "../../src/app/messaging/messageAdmission.ts";
import { createDirectCommandFixture } from "../helpers/direct-command-fixtures.tsx";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";

  test("direct command parser supports owner bootstrap command", async () => {
    assert.deepEqual(parseDirectCommand(".own"), { name: "own" });
    assert.deepEqual(parseDirectCommand("。own 123456"), { name: "own", userId: "123456" });
    assert.deepEqual(parseDirectCommand(".debug"), { name: "debug", mode: "status" });
    assert.deepEqual(parseDirectCommand(".debug once"), { name: "debug", mode: "once" });
    assert.deepEqual(parseDirectCommand(".debug once 发我看下现在的完整系统消息"), { name: "debug", mode: "once", inlineText: "发我看下现在的完整系统消息" });
    assert.deepEqual(parseDirectCommand(".stop"), { name: "stop" });
    assert.deepEqual(parseDirectCommand(".compact"), { name: "compact" });
    assert.deepEqual(parseDirectCommand(".compact 3"), { name: "compact", keep: 3 });
    assert.deepEqual(parseDirectCommand(".remember 我喜欢 Orama"), { name: "remember", content: "我喜欢 Orama" });
    assert.deepEqual(parseDirectCommand(".forget mem_1"), { name: "forget", memoryId: "mem_1" });
    assert.deepEqual(parseDirectCommand(".setup rp"), { name: "setup", target: "rp" });
    assert.deepEqual(parseDirectCommand(".config scenario"), { name: "config", target: "scenario" });
    assert.deepEqual(parseDirectCommand(".cancel"), { name: "cancel" });
  });

  test("direct command routing helper centralizes bootstrap and group-owner rules", async () => {
    const own = parseDirectCommand(".own");
    const debug = parseDirectCommand(".debug");
    assert.ok(own);
    assert.ok(debug);
    assert.equal(canExecuteDirectCommand(own!, { phase: "owner_bootstrap", setupState: "needs_owner", chatType: "private" }), true);
    assert.equal(canExecuteDirectCommand(debug!, { phase: "owner_bootstrap", setupState: "needs_owner", chatType: "private" }), false);
    assert.equal(canExecuteDirectCommand(debug!, {
      phase: "chat",
      setupState: "ready",
      chatType: "group",
      relationship: "owner",
      isAtMentioned: true
    }), true);
    assert.equal(canExecuteDirectCommand(debug!, {
      phase: "chat",
      setupState: "ready",
      chatType: "group",
      relationship: "known",
      isAtMentioned: true
    }), false);
  });

  test("direct command dispatch helper reports unknown command when prefixed text carries media", async () => {
    assert.deepEqual(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: ".debug on",
      hasImages: true
    }), { name: "unknown", rawText: ".debug on" });
    assert.deepEqual(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: ".debug on"
    }), { name: "debug", mode: "on" });
  });

  test("direct command dispatch helper treats any prefixed text as a command attempt", async () => {
    assert.deepEqual(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: ".unknown test"
    }), { name: "unknown", rawText: ".unknown test" });
    assert.deepEqual(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: "。unknown test"
    }), { name: "unknown", rawText: "。unknown test" });
    assert.equal(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: "unknown test"
    }), null);
  });

  test("setup and config without target resolve to explicit invalid-argument errors", async () => {
    assert.deepEqual(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: ".setup"
    }), {
      name: "invalid",
      rawText: ".setup",
      message: "`.setup` 需要一个目标参数：persona、rp 或 scenario。\n用法：`.setup persona` / `.setup rp` / `.setup scenario`。"
    });

    assert.deepEqual(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: ".config"
    }), {
      name: "invalid",
      rawText: ".config",
      message: "`.config` 需要一个目标参数：persona、rp 或 scenario。\n用法：`.config persona` / `.config rp` / `.config scenario`。"
    });
  });

  test("setup admission helpers centralize bootstrap and setup blocking rules", async () => {
    const preRouterCommand = resolvePreRouterSetupDecision({
      setupState: "needs_owner",
      channelId: "qqbot",
      eventMessageType: "private",
      eventUserId: "10001",
      selfId: "20002",
      rawText: ".own",
      segmentCount: 1
    });
    const preRouterReject = resolvePreRouterSetupDecision({
      setupState: "needs_owner",
      channelId: "qqbot",
      eventMessageType: "private",
      eventUserId: "10001",
      selfId: "20002",
      rawText: "你好",
      segmentCount: 1
    });
    const preRouterUnknown = resolvePreRouterSetupDecision({
      setupState: "needs_owner",
      channelId: "qqbot",
      eventMessageType: "private",
      eventUserId: "10001",
      selfId: "20002",
      rawText: ".unknown",
      segmentCount: 1
    });
    const postRouterGroup = resolvePostRouterSetupDecision({
      setupState: "needs_persona",
      chatType: "group",
      relationship: "owner",
      ownerBound: true
    });
    const postRouterKnownUser = resolvePostRouterSetupDecision({
      setupState: "needs_persona",
      chatType: "private",
      relationship: "known",
      ownerBound: true
    });

    assert.equal(preRouterCommand.kind, "handle_bootstrap_command");
    assert.equal(preRouterReject.kind, "reject_private_before_owner_bound");
    assert.equal(preRouterUnknown.kind, "handle_bootstrap_command");
    if (preRouterUnknown.kind === "handle_bootstrap_command") {
      assert.deepEqual(preRouterUnknown.command, { name: "unknown", rawText: ".unknown" });
    }
    assert.equal(postRouterGroup.kind, "ignore_during_setup");
    assert.equal(postRouterKnownUser.kind, "block_private_non_owner");
    if (postRouterKnownUser.kind === "block_private_non_owner") {
      assert.match(postRouterKnownUser.text, /暂时只接受管理者私聊补全角色设定/);
    }
  });

  test("direct command responses request auto retract after one minute", async () => {
    const { calls, handler } = createDirectCommandFixture();
    await handler({
      command: { name: "help" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner" }
    });

    assert.equal(calls.length, 1);
    const firstCall = calls[0];
    assert.ok(firstCall);
    assert.equal(firstCall.autoRetractAfterMs, 60000);
    assert.equal(firstCall.recordInHistory, false);
    assert.equal(firstCall.recordForRetract, false);
    assert.match(firstCall.text, /\.debug \[on\|off\|once \[文本\]\|status\]/);
    assert.match(firstCall.text, /\.own \[userId\]/);
  });

  test("stop command cancels generation without clearing session", async () => {
    let cancelCalled = 0;
    let clearCalled = 0;
    const { calls, handler } = createDirectCommandFixture({
      session: { isGenerating: true },
      cancelGeneration() {
        cancelCalled += 1;
        return true;
      },
      clearSession() {
        clearCalled += 1;
      }
    });

    await handler({
      command: { name: "stop" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner" }
    });

    assert.equal(cancelCalled, 1);
    assert.equal(clearCalled, 0);
    assert.equal(calls.length, 1);
    const firstCall = calls[0];
    assert.ok(firstCall);
    assert.equal(firstCall.text, "已强行停止当前回答生成。");
  });

  test("compact command triggers forced compression", async () => {
    let cancelCalled = 0;
    const compactCalls: Array<{ sessionId: string; keep: number | undefined }> = [];
    const { calls, handler } = createDirectCommandFixture({
      session: {
        isGenerating: true,
        recentMessages: [{ role: "user", content: "a", timestampMs: 1 }]
      },
      cancelGeneration() {
        cancelCalled += 1;
        return true;
      },
      async forceCompactSession(sessionId: string, keep?: number) {
        compactCalls.push({ sessionId, keep });
        return true;
      }
    });

    await handler({
      command: { name: "compact" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner" }
    });

    assert.equal(cancelCalled, 1);
    assert.deepEqual(compactCalls, [{ sessionId: "qqbot:p:owner", keep: undefined }]);
    assert.equal(calls.length, 1);
    const firstCall = calls[0];
    assert.ok(firstCall);
    assert.equal(firstCall.text, "当前会话历史已强制压缩。");
  });

  test("compact command forwards explicit keep count", async () => {
    const compactCalls: Array<{ sessionId: string; keep: number | undefined }> = [];
    const { handler } = createDirectCommandFixture({
      async forceCompactSession(sessionId: string, keep?: number) {
        compactCalls.push({ sessionId, keep });
        return true;
      }
    });

    await handler({
      command: { name: "compact", keep: 3 },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner" }
    });

    assert.deepEqual(compactCalls, [{ sessionId: "qqbot:p:owner", keep: 3 }]);
  });

  test("debug command toggles session debug mode for owner only", async () => {
    const debugState = { enabled: false, oncePending: false };
    const debugMarkers: Array<Record<string, unknown>> = [];
    const persistReasons: string[] = [];
    const { calls, handler } = createDirectCommandFixture({
      session: { debugControl: { ...debugState } },
      appendDebugMarker(_sessionId, marker) {
        debugMarkers.push(marker);
      },
      persistSession(_sessionId, reason) {
        persistReasons.push(reason);
      },
      setDebugEnabled(_sessionId: string, enabled: boolean) {
        debugState.enabled = enabled;
        if (!enabled) {
          debugState.oncePending = false;
        }
        return { ...debugState };
      },
      armDebugOnce() {
        debugState.oncePending = true;
        return { ...debugState };
      },
      getDebugControlState() {
        return { ...debugState };
      }
    });

    await handler({ command: { name: "debug", mode: "once" }, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
    await handler({ command: { name: "debug", mode: "status" }, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
    await handler({ command: { name: "debug", mode: "off" }, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
    await handler({ command: { name: "debug", mode: "on" }, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "known" } });

    assert.equal(calls.length, 4);
    const [firstCall, secondCall, thirdCall, fourthCall] = calls;
    assert.ok(firstCall);
    assert.ok(secondCall);
    assert.ok(thirdCall);
    assert.ok(fourthCall);
    assert.match(firstCall.text, /一次性调试/);
    assert.match(secondCall.text, /单次=待触发/);
    assert.equal(thirdCall.text, "当前会话调试模式已关闭，后续回复将默认隐藏内部机制。");
    assert.equal(fourthCall.text, "只有 owner 可以切换调试模式。");
    assert.equal(debugMarkers.length, 2);
    assert.equal(debugMarkers[0]!.kind, "debug_once_armed");
    assert.equal(debugMarkers[1]!.kind, "debug_disabled");
    assert.deepEqual(persistReasons, ["debug_once_armed", "debug_disabled"]);
  });

  test("reset command exists in parseDirectCommand", async () => {
    const parsed = parseDirectCommand(".reset");
    assert.ok(parsed, "reset command must be parseable");
    assert.equal(parsed.name, "reset");
  });

  test("reset command is not allowed in rp_assistant mode", async () => {
    const parsed = parseDirectCommand(".reset");
    assert.ok(parsed);
    const allowed = canExecuteDirectCommand(parsed, {
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      sessionModeId: "rp_assistant"
    });
    assert.equal(allowed, false, "reset should not be allowed in rp_assistant mode");
  });

  test("reset command is allowed in scenario_host mode", async () => {
    const parsed = parseDirectCommand(".reset");
    assert.ok(parsed);
    const allowed = canExecuteDirectCommand(parsed, {
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      sessionModeId: "scenario_host"
    });
    assert.equal(allowed, true, "reset should be allowed in scenario_host mode");
  });

  test("clear command is allowed regardless of sessionModeId", async () => {
    const parsed = parseDirectCommand(".clear");
    assert.ok(parsed);
    const allowed = canExecuteDirectCommand(parsed, {
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      sessionModeId: "scenario_host"
    });
    assert.equal(allowed, true);
  });

  test("resolveDispatchableDirectCommand returns reset only in scenario_host", async () => {
    const inScenario = resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      isAtMentioned: false,
      text: ".reset",
      sessionModeId: "scenario_host"
    });
    assert.ok(inScenario, "should resolve in scenario_host");
    assert.equal(inScenario.name, "reset");

    const inRp = resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      isAtMentioned: false,
      text: ".reset",
      sessionModeId: "rp_assistant"
    });
    assert.deepEqual(inRp, { name: "unknown", rawText: ".reset" }, "should report unknown command in rp_assistant");
  });

  test("unknown direct command returns explicit error message", async () => {
    const { calls, handler } = createDirectCommandFixture();

    await handler({
      command: { name: "unknown", rawText: ".not-found test" } as any,
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner" }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.text, "未知指令：.not-found test\n发送 .help 查看可用指令。");
  });

  test("invalid direct command returns explicit usage message", async () => {
    const { calls, handler } = createDirectCommandFixture();

    await handler({
      command: {
        name: "invalid",
        rawText: ".setup",
        message: "`.setup` 需要一个目标参数：persona、rp 或 scenario。\n用法：`.setup persona` / `.setup rp` / `.setup scenario`。"
      } as any,
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner" }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.text, "`.setup` 需要一个目标参数：persona、rp 或 scenario。\n用法：`.setup persona` / `.setup rp` / `.setup scenario`。");
  });

  test("remember and forget direct commands write context facts", async () => {
    const writes: Record<string, unknown>[] = [];
    const removes: Array<{ userId: string; memoryId: string }> = [];
    const { calls, handler } = createDirectCommandFixture({
      contextStore: {
        upsertUserFact(input: Record<string, unknown>) {
          writes.push(input);
          return { item: { id: "mem_created", title: String(input.title) } };
        },
        removeUserFact(userId: string, memoryId: string) {
          removes.push({ userId, memoryId });
          return { removed: true, remaining: [] };
        }
      }
    });

    await handler({
      command: { name: "remember", content: "我喜欢 Orama" } as any,
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });
    await handler({
      command: { name: "forget", memoryId: "mem_created" } as any,
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner" }
    });

    assert.equal(writes[0]?.userId, "owner");
    assert.equal(writes[0]?.content, "我喜欢 Orama");
    assert.equal(writes[0]?.source, "owner_explicit");
    assert.deepEqual(removes, [{ userId: "owner", memoryId: "mem_created" }]);
    assert.match(calls[0]?.text ?? "", /已记住/);
    assert.equal(calls[1]?.text, "已忘记：mem_created");
  });

  test("direct command replies forward external user id for onebot delivery", async () => {
    const { calls, handler } = createDirectCommandFixture();

    await handler({
      command: {
        name: "invalid",
        rawText: ".setup",
        message: "`.setup` 需要一个目标参数：persona、rp 或 scenario。\n用法：`.setup persona` / `.setup rp` / `.setup scenario`。"
      } as any,
      sessionId: "qqbot:p:owner",
      incomingMessage: {
        chatType: "private",
        userId: "owner",
        externalUserId: "2254600711"
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.userId, "owner");
    assert.equal(calls[0]?.externalUserId, "2254600711");
  });

  test("setup command enters mode_setup with empty rp draft", async () => {
    let latestOperationMode: Record<string, unknown> | null = null;
    const { calls, handler } = createDirectCommandFixture({
      setOperationMode(_sessionId, operationMode) {
        latestOperationMode = operationMode as Record<string, unknown>;
        return operationMode;
      },
      rpProfileStore: {
        createEmpty() {
          return createEmptyRpProfile();
        },
        async get() {
          return createEmptyRpProfile();
        }
      },
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "uninitialized",
            scenario: "ready",
            updatedAt: 1
          };
        },
        async setPersonaReadiness() {
          return null;
        }
      } as any
    });

    await handler({
      command: { name: "setup", target: "rp" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.deepEqual(latestOperationMode, {
      kind: "mode_setup",
      modeId: "rp_assistant",
      draft: createEmptyRpProfile()
    });
    assert.match(String(calls.at(-1)?.text ?? ""), /已进入 RP 资料 初始化流程/);
  });

  test("setup command restarts persona from an empty draft even after initialization", async () => {
    let latestOperationMode: Record<string, unknown> | null = null;
    const { calls, handler } = createDirectCommandFixture({
      setOperationMode(_sessionId, operationMode) {
        latestOperationMode = operationMode as Record<string, unknown>;
        return operationMode;
      },
      personaStore: {
        async get() {
          return {
            ...createEmptyPersona(),
            name: "Mina",
            temperament: "冷静",
            speakingStyle: "短句",
            globalTraits: "创作者"
          };
        },
        createEmpty() {
          return createEmptyPersona();
        },
        isComplete() {
          return true;
        }
      },
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            scenario: "ready",
            updatedAt: 1
          };
        },
        async setPersonaReadiness() {
          return null;
        }
      } as any
    });

    await handler({
      command: { name: "setup", target: "persona" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.deepEqual(latestOperationMode, {
      kind: "persona_setup",
      draft: createEmptyPersona()
    });
    assert.match(String(calls.at(-1)?.text ?? ""), /已进入 persona 初始化流程/);
  });

  test("setup command restarts scenario from an empty draft even after initialization", async () => {
    let latestOperationMode: Record<string, unknown> | null = null;
    const { calls, handler } = createDirectCommandFixture({
      setOperationMode(_sessionId, operationMode) {
        latestOperationMode = operationMode as Record<string, unknown>;
        return operationMode;
      },
      scenarioProfileStore: {
        async get() {
          return {
            ...createEmptyScenarioProfile(),
            theme: "悬疑",
            hostStyle: "冷静",
            worldBaseline: "现代都市"
          };
        },
        createEmpty() {
          return createEmptyScenarioProfile();
        },
        isComplete() {
          return true;
        }
      },
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            scenario: "ready",
            updatedAt: 1
          };
        },
        async setScenarioReadiness() {
          return null;
        }
      } as any
    });

    await handler({
      command: { name: "setup", target: "scenario" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.deepEqual(latestOperationMode, {
      kind: "mode_setup",
      modeId: "scenario_host",
      draft: createEmptyScenarioProfile()
    });
    assert.match(String(calls.at(-1)?.text ?? ""), /已进入 Scenario 资料 初始化流程/);
  });

  test("config command clones saved persona into draft", async () => {
    let latestOperationMode: Record<string, unknown> | null = null;
    const savedPersona = {
      ...createEmptyPersona(),
      name: "Mina",
      temperament: "冷静",
      speakingStyle: "短句",
      globalTraits: "创作者"
    };
    const { calls, handler } = createDirectCommandFixture({
      setOperationMode(_sessionId, operationMode) {
        latestOperationMode = operationMode as Record<string, unknown>;
        return operationMode;
      },
      personaStore: {
        async get() {
          return savedPersona;
        },
        createEmpty() {
          return createEmptyPersona();
        },
        isComplete() {
          return true;
        }
      },
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "uninitialized",
            scenario: "uninitialized",
            updatedAt: 1
          };
        },
        async setPersonaReadiness() {
          return null;
        }
      } as any
    });

    await handler({
      command: { name: "config", target: "persona" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.deepEqual(latestOperationMode, {
      kind: "persona_config",
      draft: savedPersona
    });
    assert.match(String(calls.at(-1)?.text ?? ""), /已进入 persona 配置流程/);
  });

  test("config command still rejects uninitialized targets", async () => {
    const { calls, handler } = createDirectCommandFixture({
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "uninitialized",
            scenario: "uninitialized",
            updatedAt: 1
          };
        },
        async setPersonaReadiness() {
          return null;
        }
      } as any
    });

    await handler({
      command: { name: "config", target: "scenario" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.equal(calls.at(-1)?.text, "Scenario 资料尚未初始化，请先使用 `.setup scenario`。");
  });

  test("confirm command persists persona draft and clears session", async () => {
    let clearCalled = 0;
    let cancelCalled = 0;
    const writtenPersonas: unknown[] = [];
    const setupAdvanceCalls: unknown[] = [];
    const personaReadinessUpdates: Array<"uninitialized" | "ready"> = [];

    const { calls, handler } = createDirectCommandFixture({
      session: {
        operationMode: {
          kind: "persona_setup",
          draft: {
            ...createEmptyPersona(),
            name: "小满",
            temperament: "克制",
            speakingStyle: "简洁",
            globalTraits: "助手"
          }
        }
      },
      cancelGeneration() {
        cancelCalled += 1;
        return true;
      },
      clearSession() {
        clearCalled += 1;
      },
      personaStore: {
        async get() {
          return createEmptyPersona();
        },
        async write(persona: unknown) {
          writtenPersonas.push(persona);
        },
        createEmpty() {
          return createEmptyPersona();
        },
        isComplete() {
          return true;
        }
      },
      setupStore: {
        async advanceAfterPersonaUpdate(persona: unknown) {
          setupAdvanceCalls.push(persona);
          return null;
        }
      },
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "uninitialized",
            rp: "uninitialized",
            scenario: "uninitialized",
            updatedAt: 1
          };
        },
        async setPersonaReadiness(status: "uninitialized" | "ready") {
          personaReadinessUpdates.push(status);
          return null;
        }
      } as any
    });

    await handler({
      command: { name: "confirm" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.equal(cancelCalled, 1);
    assert.equal(clearCalled, 1);
    assert.equal(writtenPersonas.length, 1);
    assert.equal(setupAdvanceCalls.length, 1);
    assert.deepEqual(personaReadinessUpdates, ["ready"]);
    assert.equal(calls.at(-1)?.text, "配置已确认，当前会话历史已清空。");
  });

  test("confirm command persists mode draft and updates mode readiness", async () => {
    let clearCalled = 0;
    const writtenProfiles: unknown[] = [];
    const scenarioReadinessUpdates: Array<"uninitialized" | "ready"> = [];

    const { calls, handler } = createDirectCommandFixture({
      session: {
        modeId: "assistant",
        operationMode: {
          kind: "mode_config",
          modeId: "scenario_host",
          draft: {
            ...createEmptyScenarioProfile(),
            theme: "悬疑",
            hostStyle: "克制",
            worldBaseline: "现代都市"
          }
        }
      },
      clearSession() {
        clearCalled += 1;
      },
      scenarioProfileStore: {
        async get() {
          return createEmptyScenarioProfile();
        },
        async write(profile: unknown) {
          writtenProfiles.push(profile);
        },
        createEmpty() {
          return createEmptyScenarioProfile();
        },
        isComplete() {
          return true;
        }
      },
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "uninitialized",
            scenario: "ready",
            updatedAt: 1
          };
        },
        async setScenarioReadiness(status: "uninitialized" | "ready") {
          scenarioReadinessUpdates.push(status);
          return null;
        }
      } as any
    });

    await handler({
      command: { name: "confirm" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.equal(clearCalled, 1);
    assert.equal(writtenProfiles.length, 1);
    assert.deepEqual(scenarioReadinessUpdates, ["ready"]);
    assert.equal(calls.at(-1)?.text, "配置已确认，当前会话历史已清空。");
  });

  test("cancel command exits configuration flow and clears session", async () => {
    let clearCalled = 0;
    const { calls, handler } = createDirectCommandFixture({
      session: {
        operationMode: {
          kind: "mode_setup",
          modeId: "rp_assistant",
          draft: {
            ...createEmptyRpProfile(),
            selfPositioning: "雨夜里仍保持镇定"
          }
        }
      },
      clearSession() {
        clearCalled += 1;
      }
    });

    await handler({
      command: { name: "cancel" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.equal(clearCalled, 1);
    assert.equal(calls.at(-1)?.text, "已退出配置流程，当前会话历史已清空。");
  });

  test("configuration commands reject non-owner", async () => {
    const { calls, handler } = createDirectCommandFixture({
      session: {
        operationMode: {
          kind: "persona_config",
          draft: createEmptyPersona()
        }
      }
    });

    await handler({
      command: { name: "confirm" },
      sessionId: "qqbot:p:known",
      incomingMessage: { chatType: "private", userId: "known", relationship: "known" }
    });

    assert.equal(calls.at(-1)?.text, "只有 owner 可以进入或确认配置流程。");
  });

  test("debug once with inline text enqueues a synthetic message and flushes immediately", async () => {
    const debugMarkers: Array<Record<string, unknown>> = [];
    const syntheticMessages: Array<Record<string, unknown>> = [];
    const flushCalls: Array<{ sessionId: string; options?: { skipReplyGate?: boolean } }> = [];
    const { calls, handler } = createDirectCommandFixture({
      appendDebugMarker(_sessionId, marker) {
        debugMarkers.push(marker);
      },
      appendSyntheticPendingMessage(_sessionId, message) {
        syntheticMessages.push(message);
      },
      flushSession(sessionId, options) {
        flushCalls.push(options ? { sessionId, options } : { sessionId });
      }
    });

    await handler({
      command: { name: "debug", mode: "once", inlineText: "发我看下现在的完整系统消息" },
      sessionId: "qqbot:p:owner",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.equal(calls.length, 0);
    assert.equal(debugMarkers.length, 2);
    assert.equal(debugMarkers[0]!.kind, "debug_once_armed");
    assert.equal(debugMarkers[1]!.kind, "debug_once_consumed");
    assert.equal(syntheticMessages.length, 1);
    assert.equal(syntheticMessages[0]!.text, "发我看下现在的完整系统消息");
    assert.deepEqual(flushCalls, [{ sessionId: "qqbot:p:owner", options: { skipReplyGate: true } }]);
  });

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

  test("direct command parser supports owner bootstrap command", async () => {
    assert.deepEqual(parseDirectCommand(".own"), { name: "own" });
    assert.deepEqual(parseDirectCommand("。own 123456"), { name: "own", userId: "123456" });
    assert.deepEqual(parseDirectCommand(".debug"), { name: "debug", mode: "status" });
    assert.deepEqual(parseDirectCommand(".debug once"), { name: "debug", mode: "once" });
    assert.deepEqual(parseDirectCommand(".debug once 发我看下现在的完整系统消息"), { name: "debug", mode: "once", inlineText: "发我看下现在的完整系统消息" });
    assert.deepEqual(parseDirectCommand(".stop"), { name: "stop" });
    assert.deepEqual(parseDirectCommand(".compact"), { name: "compact" });
    assert.deepEqual(parseDirectCommand(".compact 3"), { name: "compact", keep: 3 });
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

  test("direct command dispatch helper rejects text commands when media is attached", async () => {
    assert.equal(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: ".debug on",
      hasImages: true
    }), null);
    assert.deepEqual(resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      text: ".debug on"
    }), { name: "debug", mode: "on" });
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
    assert.equal(inRp, null, "should not resolve in rp_assistant");
  });

  test("confirm command in scenario_host setup captions the session title from scenario state", async () => {
    const setTitleCalls: Array<{ sessionId: string; title: string; titleSource: "default" | "auto" | "manual" }> = [];
    const captionRequests: Array<Record<string, unknown>> = [];

    const { calls, handler } = createDirectCommandFixture({
      session: {
        id: "web:scenario",
        source: "web",
        modeId: "scenario_host",
        type: "private",
        participantRef: { kind: "user", id: "owner" },
        title: "New Scenario",
        titleSource: "default",
        setupConfirmed: false,
        historySummary: "旧的历史摘要"
      },
      scenarioHostStateStore: {
        async write(_sessionId: string, state: unknown) {
          return state;
        },
        async update(_sessionId, updater) {
          return updater({
            version: 1,
            currentSituation: "玩家刚抵达旧港，准备开始摸排。",
            currentLocation: "旧港码头",
            sceneSummary: "夜色下的旧港刚刚展开调查。",
            player: {
              userId: "owner",
              displayName: "Owner"
            },
            inventory: [],
            objectives: [{
              id: "find-bell",
              title: "调查钟声",
              status: "active",
              summary: "先查清午夜钟声来源"
            }],
            worldFacts: [],
            flags: {},
            initialized: false,
            turnIndex: 0
          });
        }
      },
      getModeId() {
        return "scenario_host";
      },
      getLlmVisibleHistory() {
        return [{
          role: "assistant",
          content: "这里的历史只是兜底，不是 setup 标题主输入",
          timestampMs: 1
        }];
      },
      setTitle(sessionId: string, title: string, titleSource: "default" | "auto" | "manual") {
        setTitleCalls.push({ sessionId, title, titleSource });
        return {} as never;
      },
      sessionCaptioner: {
        isAvailable() {
          return true;
        },
        async generateTitle(input: Record<string, unknown>) {
          captionRequests.push(input);
          return "旧港码头：初到与探查";
        }
      }
    });

    await handler({
      command: { name: "confirm" },
      sessionId: "web:scenario",
      incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" }
    });

    assert.deepEqual(setTitleCalls, [{
      sessionId: "web:scenario",
      title: "旧港码头：初到与探查",
      titleSource: "auto"
    }]);
    assert.equal(captionRequests.length, 1);
    assert.equal(captionRequests[0]?.reason, "scenario_setup");
    assert.equal(calls.at(-1)?.text, "初始化已确认，已进入正常模式。");
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

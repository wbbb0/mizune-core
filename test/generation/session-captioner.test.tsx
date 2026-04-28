import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import {
  SessionCaptioner,
  maybeAutoCaptionSessionTitle,
  shouldAutoCaptionSessionTitle
} from "../../src/app/generation/sessionCaptioner.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
  });
  return { promise, resolve };
}

  test("session captioner reads independent model and timeout config", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        sessionCaptioner: {
          enabled: true,
          timeoutMs: 9876,
          enableThinking: false
        }
      }
    });

    let capturedModelRefs: string[] | null = null;
    let capturedParams: any = null;
    const captioner = new SessionCaptioner(config, {
      isConfigured(modelRefs: string[] = []) {
        capturedModelRefs = [...modelRefs];
        return true;
      },
      async generate(params: any) {
        capturedParams = params;
        return { text: "  独立标题。  " };
      }
    } as never, pino({ level: "silent" }));

    const title = await captioner.generateTitle({
      sessionId: "qqbot:p:10001",
      modeId: "rp_assistant",
      reason: "turn_auto",
      historySummary: "最近对话摘要",
      history: [{
        role: "user",
        content: "帮我起个标题",
        timestampMs: 1
      }]
    });

    assert.equal(title, "独立标题");
    assert.deepEqual(capturedModelRefs, ["sessionCaptioner"]);
    assert.deepEqual(capturedParams.modelRefOverride, ["sessionCaptioner"]);
    assert.equal(capturedParams.timeoutMsOverride, 9876);
    assert.equal(capturedParams.enableThinkingOverride, false);
    assert.match(capturedParams.messages[1].content as string, /会话模式：rp_assistant/);
  });

  test("session captioner injects image captions for non-vision title models", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        models: {
          sessionCaptioner: {
            supportsVision: false
          }
        },
        sessionCaptioner: {
          enabled: true
        }
      }
    });

    let ensuredImageIds: string[] = [];
    let capturedUserPrompt = "";
    const captioner = new SessionCaptioner(config, {
      isConfigured() {
        return true;
      },
      async generate(params: any) {
        capturedUserPrompt = params.messages[1].content;
        return { text: "截图排版讨论" };
      }
    } as never, pino({ level: "silent" }), {
      async ensureReady(imageIds: string[]) {
        ensuredImageIds = imageIds;
        return new Map([["file_screen_1", "一张后台配置页面截图，左侧是导航栏，右侧是模型配置表单"]]);
      }
    });

    const title = await captioner.generateTitle({
      sessionId: "web:test",
      modeId: "assistant",
      reason: "turn_auto",
      historySummary: null,
      history: [{
        role: "user",
        content: "帮我看这个页面\n⟦ref kind=\"image\" image_id=\"file_screen_1\"⟧",
        timestampMs: 1
      }]
    });

    assert.equal(title, "截图排版讨论");
    assert.deepEqual(ensuredImageIds, ["file_screen_1"]);
    assert.match(capturedUserPrompt, /图片描述：一张后台配置页面截图，左侧是导航栏，右侧是模型配置表单/);
  });

  test("scenario setup captioning uses location-and-situation prompt from structured state", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        sessionCaptioner: {
          enabled: true,
          timeoutMs: 4321,
          enableThinking: false
        }
      }
    });

    let capturedParams: any = null;
    const captioner = new SessionCaptioner(config, {
      isConfigured() {
        return true;
      },
      async generate(params: any) {
        capturedParams = params;
        return { text: "旧港码头：初到与探查" };
      }
    } as never, pino({ level: "silent" }));

    const title = await captioner.generateTitle({
      sessionId: "web:scenario",
      modeId: "scenario_host",
      reason: "scenario_setup",
      historySummary: "旧标题摘要",
      history: [{
        role: "user",
        content: "这段历史不该成为 setup 命名主输入",
        timestampMs: 1
      }],
      scenarioState: {
        version: 1,
        currentSituation: "玩家刚抵达旧港，正准备摸清午夜钟声的来源。",
        currentLocation: "旧港码头",
        sceneSummary: "玩家在夜色里踏上旧港，准备开始探查。",
        player: {
          userId: "owner",
          displayName: "Owner"
        },
        inventory: [],
        objectives: [{
          id: "find-bell",
          title: "调查钟声",
          status: "active",
          summary: "先确认钟声来自哪里"
        }],
        worldFacts: ["旧港每晚零点都会响钟。"],
        flags: {},
        initialized: true,
        turnIndex: 0
      }
    });

    assert.equal(title, "旧港码头：初到与探查");
    assert.match(capturedParams.messages[0].content as string, /位置与当前局势导向/);
    assert.match(capturedParams.messages[1].content as string, /当前位置：旧港码头/);
    assert.match(capturedParams.messages[1].content as string, /当前局势：玩家刚抵达旧港/);
    assert.match(capturedParams.messages[1].content as string, /场景摘要：玩家在夜色里踏上旧港/);
    assert.match(capturedParams.messages[1].content as string, /当前目标：调查钟声：先确认钟声来自哪里/);
    assert.doesNotMatch(capturedParams.messages[1].content as string, /最近消息：/);
  });

  test("session captioner availability follows independent config", async () => {
    const enabledCaptioner = new SessionCaptioner(
      createTestAppConfig({
        llm: {
          enabled: true,
          sessionCaptioner: {
            enabled: true
          }
        }
      }),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          return { text: "标题" };
        }
      } as never,
      pino({ level: "silent" })
    );
    assert.equal(enabledCaptioner.isAvailable(), true);

    const disabledCaptioner = new SessionCaptioner(
      createTestAppConfig({
        llm: {
          enabled: true,
          sessionCaptioner: {
            enabled: false
          }
        }
      }),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          return { text: "标题" };
        }
      } as never,
      pino({ level: "silent" })
    );
    assert.equal(disabledCaptioner.isAvailable(), false);
  });

  test("auto caption skips stale writes after newer history arrives", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        sessionCaptioner: {
          enabled: true
        }
      }
    });

    const deferred = createDeferred<{ text: string }>();
    let titleWrites = 0;
    let currentHistoryRevision = 1;
    const sessionManager = {
      getSession() {
        return {
          id: "qqbot:p:10001",
          type: "private" as const,
          source: "web" as const,
          modeId: "rp_assistant",
          historyRevision: currentHistoryRevision,
          titleSource: "default" as const,
          historySummary: "摘要",
          title: "旧标题"
        };
      },
      getHistoryRevision() {
        return currentHistoryRevision;
      },
      getLlmVisibleHistory() {
        return [{
          role: "user" as const,
          content: "帮我起个标题",
          timestampMs: 1
        }];
      },
      setTitle() {
        titleWrites += 1;
        throw new Error("setTitle should not be called for stale titles");
      },
      appendInternalTranscript() {
        throw new Error("appendInternalTranscript should not be called for stale titles");
      }
    } as unknown as Parameters<typeof maybeAutoCaptionSessionTitle>[0]["sessionManager"];
    const captioner = new SessionCaptioner(config, {
      isConfigured() {
        return true;
      },
      async generate() {
        return deferred.promise;
      }
    } as never, pino({ level: "silent" }));

    const task = maybeAutoCaptionSessionTitle({
      sessionId: "qqbot:p:10001",
      sessionManager,
      sessionCaptioner: captioner,
      expectedHistoryRevision: 1,
      reason: "generation_completed_captioned"
    });

    currentHistoryRevision = 2;
    deferred.resolve({ text: "新标题" });

    assert.equal(await task, false);
    assert.equal(titleWrites, 0);
  });

  test("auto caption policy only regenerates auto titles when forced", async () => {
    assert.equal(shouldAutoCaptionSessionTitle({ source: "web", titleSource: "default" }), true);
    assert.equal(shouldAutoCaptionSessionTitle({ source: "web", titleSource: "auto" }), false);
    assert.equal(shouldAutoCaptionSessionTitle({ source: "web", titleSource: "auto" }, { forceRegenerate: true }), true);
    assert.equal(shouldAutoCaptionSessionTitle({ source: "web", titleSource: "manual" }, { forceRegenerate: true }), false);
    assert.equal(shouldAutoCaptionSessionTitle({ source: "onebot", titleSource: "default" }, { forceRegenerate: true }), false);
  });

  test("forced regeneration can update auto-titled web sessions", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        sessionCaptioner: {
          enabled: true
        }
      }
    });

    let setTitleCalls = 0;
    let appendedEvents = 0;
    const sessionManager = {
      getSession() {
        return {
          id: "web:test",
          type: "private" as const,
          source: "web" as const,
          modeId: "assistant",
          historyRevision: 3,
          titleSource: "auto" as const,
          historySummary: "摘要",
          title: "旧自动标题"
        };
      },
      getLlmVisibleHistory() {
        return [{
          role: "assistant" as const,
          content: "这是新话题",
          timestampMs: 1
        }];
      },
      setTitle() {
        setTitleCalls += 1;
        return {} as never;
      },
      appendInternalTranscript() {
        appendedEvents += 1;
      }
    } as unknown as Parameters<typeof maybeAutoCaptionSessionTitle>[0]["sessionManager"];
    const captioner = new SessionCaptioner(config, {
      isConfigured() {
        return true;
      },
      async generate() {
        return { text: "新自动标题" };
      }
    } as never, pino({ level: "silent" }));

    const applied = await maybeAutoCaptionSessionTitle({
      sessionId: "web:test",
      sessionManager,
      sessionCaptioner: captioner,
      forceRegenerate: true,
      reason: "forced_regenerate"
    });

    assert.equal(applied, true);
    assert.equal(setTitleCalls, 1);
    assert.equal(appendedEvents, 1);
  });

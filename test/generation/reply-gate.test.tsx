import test from "node:test";
import assert from "node:assert/strict";
import type { LlmMessage } from "../../src/llm/llmClient.ts";
import { handleGenerationTurnPlanner } from "../../src/app/generation/generationTurnPlanner.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import {
  createGenerationReplyGateDeps,
  createGenerationReplyGateHandlers,
  createGenerationReplyGateInput,
  createReplyGate,
  createReplyGateBatchMessage
} from "../helpers/reply-gate-fixtures.tsx";

function createConfig() {
  return createTestAppConfig({
    llm: {
      enabled: true,
      models: {
        main: {
          supportsTools: false
        }
      },
      turnPlanner: {
        enabled: true
      }
    }
  });
}

  test("reply gate prompt stays concise while preserving decision boundaries", async () => {
    let capturedMessages: LlmMessage[] = [];
    const gate = createReplyGate(createConfig(), {
      async onGenerate(input) {
        capturedMessages = input.messages;
      }
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "group",
      relationship: "owner",
      currentUserSpecialRole: "npc",
      recentMessages: [
        {
          role: "assistant",
          content: "那我先不打扰你了",
          timestampMs: Date.now() - 5_000
        }
      ],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "NPC甲",
          text: "帮我改一下明天的提醒",
          mentionedSelf: true,
          timestampMs: Date.now()
        })
      ],
      availableToolsets: [
        {
          id: "scheduler_admin",
          title: "定时任务管理",
          description: "查看、创建和管理计划任务。",
          toolNames: ["create_scheduled_job"],
          plannerSignals: [
            "需要未来触发、延时提醒或周期执行"
          ]
        }
      ]
    });

    assert.equal(result.replyDecision, "reply_small");
    assert.equal(result.topicDecision, "continue_topic");
    const system = String(capturedMessages[0]?.content ?? "");
    const secondMessage = capturedMessages[1];
    const userParts: Array<{ type: string; text?: string }> =
      secondMessage && Array.isArray(secondMessage.content) ? secondMessage.content : [];
    const user = userParts.find((part: { type: string; text?: string }) => part.type === "text")?.text ?? "";
    assert.match(system, /⟦section name="planner_identity"⟧/);
    assert.match(system, /⟦section name="planner_rules"⟧/);
    assert.match(system, /reply_decision: <reply_small\|reply_large\|wait\|no_reply>/);
    assert.match(system, /私聊默认 reply_small/);
    assert.match(system, /群聊中当前批次明显不需要机器人回应时可判 no_reply/);
    assert.doesNotMatch(system, /包括但不限于/);
    assert.doesNotMatch(system, /像“取消这个吧”/);
    assert.match(user, /⟦section name="planner_batch_features"⟧/);
    assert.match(user, /signals=需要未来触发、延时提醒或周期执行/);
    assert.match(user, /tags=mention, text/);
    assert.match(user, /⟦planner_batch_message index="1"/);
  });

  test("reply gate parses structured planner semantics while keeping reason first", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: [
        "reason: 需要先看引用并打开网页",
        "reply_decision: reply_small",
        "topic_decision: continue_topic",
        "required_capabilities: web_navigation, local_file_access",
        "context_dependencies: structured_message_context, prior_web_context",
        "recent_domain_reuse: web_research",
        "followup_mode: explicit_reference",
        "toolset_ids: web_research"
      ].join("\n")
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [],
      availableToolsets: [{
        id: "web_research",
        title: "网页检索与浏览",
        description: "搜索网页、打开页面、交互与截图。",
        toolNames: ["open_page"]
      }],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "把这个页面里刚才那张图存下来",
          replyMessageId: "msg-1",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.reason, "需要先看引用并打开网页");
    assert.deepEqual(result.requiredCapabilities, ["web_navigation", "local_file_access"]);
    assert.deepEqual(result.contextDependencies, ["structured_message_context", "prior_web_context"]);
    assert.deepEqual(result.recentDomainReuse, ["web_research"]);
    assert.equal(result.followupMode, "explicit_reference");
    assert.deepEqual(result.toolsetIds, ["web_research"]);
  });

  test("group reply gate keeps no_reply and clears toolsets", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "群里闲聊无需回应|no_reply|continue_topic|web_research"
    });

    const result = await gate.decide({
      sessionId: "qqbot:g:100",
      chatType: "group",
      relationship: "known",
      recentMessages: [],
      availableToolsets: [{
        id: "web_research",
        title: "网页检索与浏览",
        description: "搜索网页、打开页面、交互与截图。",
        toolNames: ["open_page"]
      }],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "GroupMember",
          text: "我先去吃饭了",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "no_reply");
    assert.equal(result.topicDecision, "continue_topic");
    assert.deepEqual(result.toolsetIds, []);
  });

  test("private reply gate coerces model no_reply back to reply_small", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: [
        "reason: 私聊收尾",
        "reply_decision: no_reply",
        "topic_decision: continue_topic",
        "required_capabilities: none",
        "context_dependencies: none",
        "recent_domain_reuse: none",
        "followup_mode: none",
        "toolset_ids: web_research"
      ].join("\n")
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [],
      availableToolsets: [{
        id: "web_research",
        title: "网页检索与浏览",
        description: "搜索网页、打开页面、交互与截图。",
        toolNames: ["open_page"]
      }],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "收到啦",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "reply_small");
    assert.equal(result.topicDecision, "continue_topic");
    assert.deepEqual(result.toolsetIds, []);
  });

  test("generation reply gate bypasses audio-only batches", async () => {
    let llmCalled = false;
    const result = await handleGenerationTurnPlanner(
      createGenerationReplyGateDeps({
        config: createConfig(),
        turnPlanner: {
          isEnabled() {
            return true;
          },
          async decide() {
            llmCalled = true;
            return { replyDecision: "reply_small", topicDecision: "continue_topic", reason: "should not run", toolsetIds: [] };
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["turnPlanner"],
        debounceManager: {
          schedule() {
            throw new Error("should not reschedule audio-only batch");
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["debounceManager"],
        historyCompressor: {
          async maybeCompress() {},
          async compactOldHistoryKeepingRecent() {}
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["historyCompressor"],
        sessionManager: {
          requeuePendingMessages() {
            throw new Error("should not requeue audio-only batch");
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["sessionManager"],
        persistSession() {}
      }),
      createGenerationReplyGateHandlers(),
      createGenerationReplyGateInput()
    );

    assert.equal(result.action, "continue");
    if (result.action === "continue") {
      assert.deepEqual(result.resolvedModelRef, ["main"]);
      assert.deepEqual(result.toolsetIds, []);
    }
    assert.equal(llmCalled, false);
  });

  test("reply gate no longer locally ignores explicit chat-closing acknowledgements", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "礼貌收尾但仍可接住|reply_small|continue_topic"
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "好的",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "reply_small");
  });

  test("generation reply gate compacts old history on topic switch", async () => {
    const compactCalls: Array<{ sessionId: string; keep: number }> = [];
    const persistReasons: string[] = [];
    const result = await handleGenerationTurnPlanner(
      createGenerationReplyGateDeps({
        config: createConfig(),
        turnPlanner: {
          isEnabled() {
            return true;
          },
          async decide() {
            return { replyDecision: "reply_large", topicDecision: "new_topic", reason: "明显换题", toolsetIds: [] };
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["turnPlanner"],
        historyCompressor: {
          async maybeCompress() {},
          async compactOldHistoryKeepingRecent(sessionId: string, keep: number) {
            compactCalls.push({ sessionId, keep });
            return true;
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["historyCompressor"],
        persistSession(_sessionId, reason) {
          persistReasons.push(reason);
        }
      }),
      createGenerationReplyGateHandlers(),
      createGenerationReplyGateInput({
        batchMessages: [
          {
            ...createGenerationReplyGateInput().batchMessages[0]!,
            audioSources: [],
            text: "另外我想问出游预算",
            receivedAt: Date.now()
          }
        ]
      })
    );

    assert.equal(result.action, "continue");
    if (result.action === "continue") {
      assert.deepEqual(result.resolvedModelRef, ["main"]);
      assert.deepEqual(result.toolsetIds, []);
    }
    assert.deepEqual(compactCalls, [{ sessionId: "qqbot:p:audio", keep: 1 }]);
    assert.deepEqual(persistReasons, ["turn_planner_topic_switch_compacted"]);
  });

  test("generation reply gate records group no_reply and skips main model", async () => {
    const transcriptItems: Array<Record<string, unknown>> = [];
    const persistReasons: string[] = [];
    const result = await handleGenerationTurnPlanner(
      createGenerationReplyGateDeps({
        config: createConfig(),
        turnPlanner: {
          isEnabled() {
            return true;
          },
          async decide() {
            return {
              replyDecision: "no_reply",
              topicDecision: "continue_topic",
              reason: "群聊无需回应",
              requiredCapabilities: [],
              contextDependencies: [],
              recentDomainReuse: [],
              followupMode: "none",
              toolsetIds: []
            };
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["turnPlanner"],
        sessionManager: {
          appendInternalTranscript(_sessionId: string, item: Record<string, unknown>) {
            transcriptItems.push(item);
          },
          requeuePendingMessages() {
            throw new Error("should not requeue no_reply batch");
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["sessionManager"],
        debounceManager: {
          schedule() {
            throw new Error("should not reschedule no_reply batch");
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["debounceManager"],
        persistSession(_sessionId, reason) {
          persistReasons.push(reason);
        }
      }),
      createGenerationReplyGateHandlers(),
      createGenerationReplyGateInput({
        sendTarget: {
          delivery: "onebot",
          chatType: "group",
          groupId: "20001",
          userId: "10001",
          senderName: "Tester"
        },
        batchMessages: [
          {
            ...createGenerationReplyGateInput().batchMessages[0]!,
            chatType: "group",
            groupId: "20001",
            audioSources: [],
            text: "我先去吃饭了",
            receivedAt: Date.now()
          }
        ]
      })
    );

    assert.equal(result.action, "skip");
    assert.equal(transcriptItems.length, 1);
    assert.equal(transcriptItems[0]?.kind, "gate_decision");
    assert.equal(transcriptItems[0]?.action, "skip");
    assert.equal(transcriptItems[0]?.replyDecision, "no_reply");
    assert.equal(transcriptItems[0]?.reason, "群聊无需回应");
    assert.equal(transcriptItems[0]?.toolsetIds, undefined);
    assert.deepEqual(persistReasons, ["turn_planner_skip_recorded"]);
  });

  test("generation reply gate coerces no_reply for explicit group mentions", async () => {
    const transcriptItems: Array<Record<string, unknown>> = [];
    const result = await handleGenerationTurnPlanner(
      createGenerationReplyGateDeps({
        config: createConfig(),
        turnPlanner: {
          isEnabled() {
            return true;
          },
          async decide() {
            return {
              replyDecision: "no_reply",
              topicDecision: "continue_topic",
              reason: "误判无需回应",
              requiredCapabilities: [],
              contextDependencies: [],
              recentDomainReuse: [],
              followupMode: "none",
              toolsetIds: []
            };
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["turnPlanner"],
        sessionManager: {
          appendInternalTranscript(_sessionId: string, item: Record<string, unknown>) {
            transcriptItems.push(item);
          },
          requeuePendingMessages() {
            throw new Error("should not requeue coerced no_reply batch");
          }
        } as unknown as ReturnType<typeof createGenerationReplyGateDeps>["sessionManager"]
      }),
      createGenerationReplyGateHandlers(),
      createGenerationReplyGateInput({
        sendTarget: {
          delivery: "onebot",
          chatType: "group",
          groupId: "20001",
          userId: "10001",
          senderName: "Tester"
        },
        batchMessages: [
          {
            ...createGenerationReplyGateInput().batchMessages[0]!,
            chatType: "group",
            groupId: "20001",
            audioSources: [],
            text: "@bot 这个怎么处理",
            isAtMentioned: true,
            receivedAt: Date.now()
          }
        ]
      })
    );

    assert.equal(result.action, "continue");
    if (result.action === "continue") {
      assert.deepEqual(result.resolvedModelRef, ["main"]);
      assert.deepEqual(result.toolsetIds, []);
      assert.equal(result.plannerDecision?.replyDecision, "reply_small");
    }
    assert.equal(transcriptItems[0]?.replyDecision, "reply_small");
    assert.equal(transcriptItems[0]?.action, "continue");
  });

  test("reply gate coerces model ignore decisions back to reply for normal requests", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "请求敏感内容|ignore"
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "打开成人网站看一下分类",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "reply_small");
  });

  test("reply gate coerces no-reply wait decisions back to reply", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "对方只是确认无需回复|wait"
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "收到啦",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "reply_small");
  });

  test("reply gate keeps wait only for clearly unfinished text", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "半句话未完|wait"
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "比如说",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "wait");
    assert.equal(result.topicDecision, "continue_topic");
  });

  test("reply gate degrades to reply_small on LLM timeout error", async () => {
    const gate = createReplyGate(createConfig(), {
      async onGenerate() {
        throw new Error("LLM total timeout after 20000ms");
      }
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "看现场照片的时候有没有什么需要关注的",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "reply_small");
    assert.equal(result.topicDecision, "continue_topic");
  });

  test("reply gate degrades to reply_small on other LLM errors", async () => {
    const gate = createReplyGate(createConfig(), {
      async onGenerate() {
        throw new Error("network error");
      }
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "今天天气怎么样",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "reply_small");
    assert.equal(result.topicDecision, "continue_topic");
  });

  test("reply gate parses topic_switch decisions", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "明显换题了|reply_large|new_topic"
    });

    const result = await gate.decide({
      sessionId: "qqbot:p:owner",
      chatType: "private",
      relationship: "owner",
      recentMessages: [
        {
          role: "user",
          content: "我们刚在聊装修预算",
          timestampMs: Date.now() - 5_000
        }
      ],
      batchMessages: [
        createReplyGateBatchMessage({
          senderName: "Owner",
          text: "另外我想问下周旅游预算怎么定",
          timestampMs: Date.now()
        })
      ]
    });

    assert.equal(result.replyDecision, "reply_large");
    assert.equal(result.topicDecision, "new_topic");
    assert.equal(result.reason, "明显换题了");
  });

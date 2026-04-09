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

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("reply gate prompt stays concise while preserving decision boundaries", async () => {
    let capturedMessages: LlmMessage[] = [];
    const gate = createReplyGate(createConfig(), {
      async onGenerate(input) {
        capturedMessages = input.messages;
      }
    });

    const result = await gate.decide({
      sessionId: "private:owner",
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
    assert.doesNotMatch(system, /包括但不限于/);
    assert.doesNotMatch(system, /像“取消这个吧”/);
    assert.match(user, /⟦section name="planner_batch_features"⟧/);
    assert.match(user, /tags=mention, text/);
    assert.match(user, /⟦planner_batch_message index="1"/);
  });

  await runCase("generation reply gate bypasses audio-only batches", async () => {
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

    assert.deepEqual(result, { action: "continue", resolvedModelRef: ["main"], toolsetIds: [] });
    assert.equal(llmCalled, false);
  });

  await runCase("reply gate no longer locally ignores explicit chat-closing acknowledgements", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "礼貌收尾但仍可接住|reply_small|continue_topic"
    });

    const result = await gate.decide({
      sessionId: "private:owner",
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

  await runCase("generation reply gate compacts old history on topic switch", async () => {
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

    assert.deepEqual(result, { action: "continue", resolvedModelRef: ["main"], toolsetIds: [] });
    assert.deepEqual(compactCalls, [{ sessionId: "private:audio", keep: 1 }]);
    assert.deepEqual(persistReasons, ["turn_planner_topic_switch_compacted"]);
  });

  await runCase("reply gate coerces model ignore decisions back to reply for normal requests", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "请求敏感内容|ignore"
    });

    const result = await gate.decide({
      sessionId: "private:owner",
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

  await runCase("reply gate coerces no-reply wait decisions back to reply", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "对方只是确认无需回复|wait"
    });

    const result = await gate.decide({
      sessionId: "private:owner",
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

  await runCase("reply gate keeps wait only for clearly unfinished text", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "半句话未完|wait"
    });

    const result = await gate.decide({
      sessionId: "private:owner",
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

  await runCase("reply gate degrades to reply_small on LLM timeout error", async () => {
    const gate = createReplyGate(createConfig(), {
      async onGenerate() {
        throw new Error("LLM total timeout after 20000ms");
      }
    });

    const result = await gate.decide({
      sessionId: "private:owner",
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

  await runCase("reply gate degrades to reply_small on other LLM errors", async () => {
    const gate = createReplyGate(createConfig(), {
      async onGenerate() {
        throw new Error("network error");
      }
    });

    const result = await gate.decide({
      sessionId: "private:owner",
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

  await runCase("reply gate parses topic_switch decisions", async () => {
    const gate = createReplyGate(createConfig(), {
      resultText: "明显换题了|reply_large|new_topic"
    });

    const result = await gate.decide({
      sessionId: "private:owner",
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

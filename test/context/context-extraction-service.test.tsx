import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ContextExtractionService, type ContextExtractionTurn } from "../../src/context/contextExtractionService.ts";
import { ContextStore } from "../../src/context/contextStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function createHarness(generateText: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-context-extraction-test-"));
  const config = createTestAppConfig({
    llm: {
      enabled: true,
      summarizer: {
        enabled: true,
        timeoutMs: 1000,
        enableThinking: false
      }
    },
    context: {
      extraction: {
        enabled: true,
        debounceMs: 1,
        maxDelayMs: 10,
        maxTurnsPerBatch: 3,
        minConfidence: 0.7,
        relatedMemoryLimit: 8,
        timeoutMs: 1000,
        enableThinking: false
      }
    }
  });
  const store = new ContextStore(dataDir, config, pino({ level: "silent" }));
  await store.init();
  let generateCalls = 0;
  const service = new ContextExtractionService(
    config,
    {
      isConfigured: () => true,
      generate: async () => {
        generateCalls += 1;
        return {
          text: generateText,
          reasoningContent: "",
          usage: {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            cachedTokens: null,
            reasoningTokens: null,
            requestCount: 1,
            providerReported: false,
            modelRef: "main",
            model: "fake"
          }
        };
      }
    },
    store,
    pino({ level: "silent" })
  );
  return {
    store,
    service,
    getGenerateCalls: () => generateCalls,
    cleanup: async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

function turn(text: string): ContextExtractionTurn {
  return {
    sessionId: "qqbot:p:user_1",
    userId: "user_1",
    chatType: "private",
    senderName: "用户",
    userMessages: [{
      userId: "user_1",
      senderName: "用户",
      text,
      receivedAt: 1000
    }],
    assistantText: "好的，我记下了。",
    completedAt: 2000
  };
}

function groupTurn(messages: ContextExtractionTurn["userMessages"], targetUserId = "user_1"): ContextExtractionTurn {
  return {
    sessionId: "qqbot:g:group_1",
    userId: targetUserId,
    chatType: "group",
    senderName: targetUserId,
    userMessages: messages,
    assistantText: "好的",
    completedAt: 2000
  };
}

test("ContextExtractionService creates and replaces stable user memories", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [
      {
        action: "replace",
        title: "早餐习惯",
        content: "用户早餐改成全麦吐司配牛油果，不再吃酸奶",
        kind: "habit",
        importance: 4,
        confidence: 0.92
      },
      {
        action: "create",
        title: "回答偏好",
        content: "用户喜欢先给结论，再补充关键原因",
        kind: "preference",
        importance: 4,
        confidence: 0.86
      },
      {
        action: "create",
        title: "低置信内容",
        content: "用户今天在测试记忆功能",
        kind: "other",
        importance: 1,
        confidence: 0.2
      }
    ]
  }));
  try {
    const existing = harness.store.upsertUserFact({
      userId: "user_1",
      title: "早餐习惯",
      content: "用户早餐固定吃希腊酸奶加蓝莓和奇亚籽",
      kind: "habit",
      importance: 4
    });

    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("更新一下，我早餐改成全麦吐司配牛油果，不再吃酸奶。以后回答先给结论。")]
    });

    assert.deepEqual(result, { created: 1, replaced: 1, ignored: 1 });
    const memories = harness.store.listUserFacts("user_1");
    assert.equal(memories.length, 2);
    assert.equal(memories.find((item) => item.id === existing.item.id)?.content, "用户早餐改成全麦吐司配牛油果，不再吃酸奶");
    assert.equal(memories.find((item) => item.title === "回答偏好")?.source, "inferred");
    assert.equal(harness.getGenerateCalls(), 1);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService lets extractor decide no-op conversations", async () => {
  const harness = await createHarness(JSON.stringify({ items: [] }));
  try {
    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("这个函数现在为什么报错？")]
    });

    assert.deepEqual(result, { created: 0, replaced: 0, ignored: 0 });
    assert.equal(harness.getGenerateCalls(), 1);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService passes short stable facts to extractor", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      title: "称呼偏好",
      content: "用户希望被称为阿明",
      kind: "preference",
      importance: 4,
      confidence: 0.9
    }]
  }));
  try {
    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("叫我阿明")]
    });

    assert.deepEqual(result, { created: 1, replaced: 0, ignored: 0 });
    assert.equal(harness.store.listUserFacts("user_1")[0]?.content, "用户希望被称为阿明");
    assert.equal(harness.getGenerateCalls(), 1);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService skips when target user has no text in batch", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      title: "错误记忆",
      content: "不应写入",
      kind: "fact",
      importance: 1,
      confidence: 1
    }]
  }));
  try {
    const result = await harness.service.processTurns({
      sessionId: "qqbot:g:group_1",
      userId: "user_1",
      turns: [groupTurn([{
        userId: "user_2",
        senderName: "旁观者",
        text: "我住北京，喜欢绿茶",
        receivedAt: 1000
      }])]
    });

    assert.deepEqual(result, { created: 0, replaced: 0, ignored: 0 });
    assert.equal(harness.getGenerateCalls(), 0);
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService replaces unique same-title memory when replace id is missing", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "replace",
      title: "回答偏好",
      content: "用户喜欢先给结论",
      kind: "preference",
      importance: 4,
      confidence: 0.9
    }]
  }));
  try {
    const existing = harness.store.upsertUserFact({
      userId: "user_1",
      title: "回答偏好",
      content: "用户喜欢先给结论，再补充关键原因",
      kind: "preference",
      importance: 4
    });

    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("更新一下，以后回答只要先给结论就行。")]
    });

    assert.deepEqual(result, { created: 0, replaced: 1, ignored: 0 });
    const memories = harness.store.listUserFacts("user_1");
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.id, existing.item.id);
    assert.equal(memories[0]?.content, "用户喜欢先给结论");
  } finally {
    await harness.cleanup();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ContextExtractionService, type ContextExtractionResult, type ContextExtractionTurn } from "../../src/context/contextExtractionService.ts";
import { ContextStore } from "../../src/context/contextStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function createHarness(generateText: string | (() => string)) {
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
  let lastPromptMessages: unknown[] = [];
  const service = new ContextExtractionService(
    config,
    {
      isConfigured: () => true,
      generate: async (input) => {
        generateCalls += 1;
        lastPromptMessages = input.messages;
        return {
          text: typeof generateText === "function" ? generateText() : generateText,
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
    getLastPromptMessages: () => lastPromptMessages,
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

function assertExtractionCounts(
  result: ContextExtractionResult,
  expected: { created: number; replaced: number; ignored: number }
): void {
  assert.deepEqual({
    created: result.created,
    replaced: result.replaced,
    ignored: result.ignored
  }, expected);
}

test("ContextExtractionService creates and replaces stable user memories", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [
      {
        action: "replace",
        operation: "update_existing",
        scope: "user",
        slotKey: "breakfast_habit",
        title: "早餐习惯",
        content: "用户早餐改成全麦吐司配牛油果，不再吃酸奶",
        kind: "habit",
        importance: 4,
        confidence: 0.92
      },
      {
        action: "create",
        operation: "create",
        scope: "user",
        slotKey: "communication_preference",
        title: "回答偏好",
        content: "用户喜欢先给结论，再补充关键原因",
        kind: "preference",
        importance: 4,
        confidence: 0.86
      },
      {
        action: "create",
        operation: "create",
        scope: "user",
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
      slotKey: "breakfast_habit",
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

    assertExtractionCounts(result, { created: 1, replaced: 1, ignored: 1 });
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

    assertExtractionCounts(result, { created: 0, replaced: 0, ignored: 0 });
    assert.equal(harness.getGenerateCalls(), 1);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService captures explicit session purpose as session-scoped context, not user fact", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      operation: "create",
      scope: "session",
      slotKey: "session_purpose",
      title: "会话用途",
      content: "此会话专门用于记忆系统一阶段测试",
      kind: "other",
      importance: 3,
      confidence: 0.95
    }]
  }));
  try {
    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("此会话专门用于记忆系统一阶段测试。")]
    });

    assertExtractionCounts(result, { created: 1, replaced: 0, ignored: 0 });
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
    const sessionFacts = harness.store.listSessionFacts("qqbot:p:user_1");
    assert.equal(sessionFacts.length, 1);
    assert.equal(sessionFacts[0]?.title, "会话用途");
    assert.equal(sessionFacts[0]?.content, "此会话专门用于记忆系统一阶段测试");
    const systemPrompt = (harness.getLastPromptMessages()[0] as { content: string }).content;
    assert.match(systemPrompt, /scope=user/);
    assert.match(systemPrompt, /scope=session/);
    assert.match(systemPrompt, /scope=global/);
    assert.match(systemPrompt, /scope=toolset/);
    assert.match(systemPrompt, /scope=mode/);
    assert.match(systemPrompt, /session 范围必须显式写 scope=session/);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService replaces an existing session purpose when the user changes the current session topic", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "replace",
      operation: "update_existing",
      scope: "session",
      slotKey: "session_purpose",
      title: "会话用途",
      content: "此会话现在专门用于记忆系统二阶段测试",
      kind: "fact",
      importance: 4,
      confidence: 0.93
    }]
  }));
  try {
    const existing = harness.store.upsertSessionFact({
      sessionId: "qqbot:p:user_1",
      slotKey: "session_purpose",
      title: "会话用途",
      content: "此会话专门用于记忆系统一阶段测试",
      kind: "fact",
      importance: 4
    });

    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("更新一下，此会话现在专门用于记忆系统二阶段测试。")]
    });

    assertExtractionCounts(result, { created: 0, replaced: 1, ignored: 0 });
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
    const sessionFacts = harness.store.listSessionFacts("qqbot:p:user_1");
    assert.equal(sessionFacts.length, 1);
    assert.equal(sessionFacts[0]?.id, existing.item.id);
    assert.equal(sessionFacts[0]?.content, "此会话现在专门用于记忆系统二阶段测试");
    const promptPayload = JSON.parse((harness.getLastPromptMessages()[1] as { content: string }).content) as {
      related_memories: Array<{ scope: string; id: string; slotKey?: string }>;
    };
    assert.deepEqual(promptPayload.related_memories.map((item) => ({ scope: item.scope, id: item.id, slotKey: item.slotKey })), [{
      scope: "session",
      id: existing.item.id,
      slotKey: "session_purpose"
    }]);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService keeps explicit session agenda while ignoring one-off task chatter", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      operation: "create",
      scope: "session",
      slotKey: "session_purpose",
      title: "会话用途",
      content: "此会话专门用于记忆系统测试",
      kind: "fact",
      importance: 4,
      confidence: 0.94
    }, {
      action: "ignore",
      operation: "noop",
      scope: "session",
      confidence: 1
    }]
  }));
  try {
    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("此会话专门用于记忆系统测试。顺手帮我算一下 2+2。")]
    });

    assertExtractionCounts(result, { created: 1, replaced: 0, ignored: 1 });
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
    const sessionFacts = harness.store.listSessionFacts("qqbot:p:user_1");
    assert.equal(sessionFacts.length, 1);
    assert.equal(sessionFacts[0]?.content, "此会话专门用于记忆系统测试");
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService keeps group session purpose scoped to the group session", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      operation: "create",
      scope: "session",
      slotKey: "session_purpose",
      title: "会话用途",
      content: "本群此会话专门用于记忆系统测试",
      kind: "fact",
      importance: 4,
      confidence: 0.92
    }]
  }));
  try {
    const messages = [{
      userId: "user_1",
      senderName: "Alice",
      text: "本群此会话专门用于记忆系统测试。",
      receivedAt: 1000
    }, {
      userId: "user_2",
      senderName: "Bob",
      text: "我也在这个群里参与。",
      receivedAt: 1100
    }];

    const first = await harness.service.processTurns({
      sessionId: "qqbot:g:group_1",
      userId: "user_1",
      turns: [groupTurn(messages, "user_1")]
    });
    const second = await harness.service.processTurns({
      sessionId: "qqbot:g:group_1",
      userId: "user_2",
      turns: [groupTurn(messages, "user_2")]
    });

    assertExtractionCounts(first, { created: 1, replaced: 0, ignored: 0 });
    assertExtractionCounts(second, { created: 0, replaced: 0, ignored: 1 });
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
    assert.deepEqual(harness.store.listUserFacts("user_2"), []);
    const sessionFacts = harness.store.listSessionFacts("qqbot:g:group_1");
    assert.equal(sessionFacts.length, 1);
    assert.equal(sessionFacts[0]?.content, "本群此会话专门用于记忆系统测试");
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService ignores create and replace candidates without an explicit valid scope", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      operation: "create",
      title: "会话用途",
      content: "此会话专门用于记忆系统测试",
      kind: "fact",
      importance: 4,
      confidence: 0.95
    }, {
      action: "replace",
      operation: "update_existing",
      scope: "unsupported",
      title: "回答偏好",
      content: "用户喜欢先给结论",
      kind: "preference",
      importance: 4,
      confidence: 0.95
    }]
  }));
  try {
    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("此会话专门用于记忆系统测试。")]
    });

    assertExtractionCounts(result, { created: 0, replaced: 0, ignored: 2 });
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
    assert.deepEqual(harness.store.listSessionFacts("qqbot:p:user_1"), []);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService passes short stable facts to extractor", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      operation: "create",
      scope: "user",
      slotKey: "preferred_name",
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

    assertExtractionCounts(result, { created: 1, replaced: 0, ignored: 0 });
    assert.equal(harness.store.listUserFacts("user_1")[0]?.content, "用户希望被称为阿明");
    assert.equal(harness.getGenerateCalls(), 1);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService updates remembered nickname through recalled target memory", async () => {
  let targetMemoryId = "";
  const harness = await createHarness(() => JSON.stringify({
    items: [{
      action: "replace",
      operation: "update_existing",
      scope: "user",
      targetMemoryId,
      slotKey: "preferred_name",
      title: "称呼偏好",
      content: "用户希望被称为小王",
      kind: "preference",
      importance: 5,
      confidence: 0.96
    }]
  }));
  try {
    const existing = harness.store.upsertUserFact({
      userId: "user_1",
      slotKey: "preferred_name",
      title: "称呼偏好",
      content: "用户希望被称为阿明",
      kind: "preference",
      importance: 5
    });
    targetMemoryId = existing.item.id;

    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("改一下，以后叫我小王，不要叫阿明了。")]
    });

    assertExtractionCounts(result, { created: 0, replaced: 1, ignored: 0 });
    const memories = harness.store.listUserFacts("user_1");
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.id, existing.item.id);
    assert.equal(memories[0]?.slotKey, "preferred_name");
    assert.equal(memories[0]?.content, "用户希望被称为小王");
    const promptPayload = JSON.parse((harness.getLastPromptMessages()[1] as { content: string }).content) as {
      related_memories: Array<{ scope: string; id: string; slotKey?: string }>;
    };
    assert.deepEqual(promptPayload.related_memories.map((item) => ({ scope: item.scope, id: item.id, slotKey: item.slotKey })), [{
      scope: "user",
      id: existing.item.id,
      slotKey: "preferred_name"
    }]);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService supersedes changed residence by slot key", async () => {
  let targetMemoryId = "";
  const harness = await createHarness(() => JSON.stringify({
    items: [{
      action: "replace",
      operation: "invalidate_and_create",
      scope: "user",
      targetMemoryId,
      conflictsWithMemoryIds: [targetMemoryId],
      slotKey: "residence",
      title: "常住地",
      content: "用户现在常住杭州",
      kind: "fact",
      importance: 4,
      confidence: 0.95
    }]
  }));
  try {
    const existing = harness.store.upsertUserFact({
      userId: "user_1",
      slotKey: "residence",
      title: "常住地",
      content: "用户常住上海",
      kind: "fact",
      importance: 4
    });
    targetMemoryId = existing.item.id;

    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("我现在搬到杭州了，以前上海那个地址不用了。")]
    });

    assertExtractionCounts(result, { created: 0, replaced: 1, ignored: 0 });
    const activeFacts = harness.store.listUserFacts("user_1");
    assert.equal(activeFacts.length, 1);
    assert.notEqual(activeFacts[0]?.id, existing.item.id);
    assert.equal(activeFacts[0]?.slotKey, "residence");
    assert.equal(activeFacts[0]?.content, "用户现在常住杭州");
    const superseded = harness.store.listContextItems({ userId: "user_1", status: "superseded" }).items;
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0]?.itemId, existing.item.id);
    assert.equal(superseded[0]?.supersededBy, activeFacts[0]?.id);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService updates same-slot create candidates instead of dropping them as duplicates", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      operation: "create",
      scope: "user",
      slotKey: "preferred_name",
      title: "称呼偏好",
      content: "用户希望被称为小王",
      kind: "preference",
      importance: 5,
      confidence: 0.94
    }]
  }));
  try {
    const existing = harness.store.upsertUserFact({
      userId: "user_1",
      slotKey: "preferred_name",
      title: "称呼偏好",
      content: "用户希望被称为阿明",
      kind: "preference"
    });

    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("以后叫我小王。")]
    });

    assertExtractionCounts(result, { created: 0, replaced: 1, ignored: 0 });
    assert.equal(harness.store.listUserFacts("user_1")[0]?.id, existing.item.id);
    assert.equal(harness.store.listUserFacts("user_1")[0]?.content, "用户希望被称为小王");
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService invalidates explicit conflict memories without relying on slot key", async () => {
  let firstConflictId = "";
  let secondConflictId = "";
  const harness = await createHarness(() => JSON.stringify({
    items: [{
      action: "replace",
      operation: "invalidate_and_create",
      scope: "user",
      targetMemoryId: firstConflictId,
      conflictsWithMemoryIds: [firstConflictId, secondConflictId],
      title: "常住地",
      content: "用户现在常住杭州",
      kind: "fact",
      importance: 4,
      confidence: 0.95
    }]
  }));
  try {
    const first = harness.store.upsertUserFact({
      userId: "user_1",
      title: "所在地",
      content: "用户常住上海",
      kind: "fact"
    });
    const second = harness.store.upsertUserFact({
      userId: "user_1",
      title: "城市",
      content: "用户所在地是苏州",
      kind: "fact"
    });
    firstConflictId = first.item.id;
    secondConflictId = second.item.id;

    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("我现在搬到杭州了，上海和苏州那些旧信息都不用了。")]
    });

    assertExtractionCounts(result, { created: 0, replaced: 1, ignored: 0 });
    const activeFacts = harness.store.listUserFacts("user_1");
    assert.equal(activeFacts.length, 1);
    assert.equal(activeFacts[0]?.content, "用户现在常住杭州");
    const supersededIds = harness.store.listContextItems({ userId: "user_1", status: "superseded" }).items.map((item) => item.itemId).sort();
    assert.deepEqual(supersededIds, [first.item.id, second.item.id].sort());
    assert.deepEqual(result.items[0]?.targetMemoryIds?.sort(), [first.item.id, second.item.id].sort());
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService recalls relevant same-slot memories beyond the related memory limit", async () => {
  const harness = await createHarness(JSON.stringify({ items: [] }));
  try {
    for (let index = 0; index < 10; index += 1) {
      harness.store.upsertUserFact({
        userId: "user_1",
        title: `无关事实 ${index}`,
        content: `用户正在测试无关上下文 ${index}`,
        kind: "other"
      });
    }
    const residence = harness.store.upsertUserFact({
      userId: "user_1",
      slotKey: "residence",
      title: "常住地",
      content: "用户常住上海",
      kind: "fact"
    });

    await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("我搬到杭州了，之前的上海地址不用了。")]
    });

    const promptPayload = JSON.parse((harness.getLastPromptMessages()[1] as { content: string }).content) as {
      related_memories: Array<{ id: string; slotKey?: string }>;
    };
    assert.ok(promptPayload.related_memories.some((item) => item.id === residence.item.id && item.slotKey === "residence"));
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService ignores global procedural rules instead of writing user memory", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "ignore",
      operation: "ignore_wrong_scope",
      scope: "global",
      confidence: 1
    }]
  }));
  try {
    const result = await harness.service.processTurns({
      sessionId: "qqbot:p:user_1",
      userId: "user_1",
      turns: [turn("以后所有任务默认先列三步计划。")]
    });

    assertExtractionCounts(result, { created: 0, replaced: 0, ignored: 1 });
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
    assert.deepEqual(harness.store.listSessionFacts("qqbot:p:user_1"), []);
  } finally {
    await harness.cleanup();
  }
});

test("ContextExtractionService skips when target user has no text in batch", async () => {
  const harness = await createHarness(JSON.stringify({
    items: [{
      action: "create",
      operation: "create",
      scope: "user",
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

    assertExtractionCounts(result, { created: 0, replaced: 0, ignored: 0 });
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
      operation: "update_existing",
      scope: "user",
      slotKey: "communication_preference",
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

    assertExtractionCounts(result, { created: 0, replaced: 1, ignored: 0 });
    const memories = harness.store.listUserFacts("user_1");
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.id, existing.item.id);
    assert.equal(memories[0]?.content, "用户喜欢先给结论");
  } finally {
    await harness.cleanup();
  }
});

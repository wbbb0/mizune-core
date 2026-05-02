import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { ContextStore } from "../../src/context/contextStore.ts";
import { createUserMemoryEntry } from "../../src/memory/userMemoryEntry.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function createContextStoreHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-context-store-test-"));
  const store = new ContextStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
  await store.init();
  return {
    dataDir,
    store,
    cleanup: async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

test("ContextStore migrates legacy user memories into user facts", async () => {
  const harness = await createContextStoreHarness();
  try {
    const legacyMemory = createUserMemoryEntry({
      id: "mem_legacy_1",
      title: "称呼",
      content: "用户希望被称为小王",
      kind: "preference",
      source: "user_explicit",
      createdAt: 100,
      updatedAt: 200,
      importance: 5,
      lastUsedAt: 300
    });

    harness.store.migrateUserMemories([{
      userId: "user_1",
      memories: [legacyMemory]
    } as any]);

    const facts = harness.store.listUserFacts("user_1");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.id, "mem_legacy_1");
    assert.equal(facts[0]?.title, "称呼");
    assert.equal(facts[0]?.content, "用户希望被称为小王");
    assert.equal(facts[0]?.kind, "preference");
    assert.equal(facts[0]?.source, "user_explicit");
    assert.equal(facts[0]?.importance, 5);
    assert.equal(facts[0]?.lastUsedAt, 300);
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore upserts and soft-deletes user facts", async () => {
  const harness = await createContextStoreHarness();
  try {
    const created = harness.store.upsertUserFact({
      userId: "user_1",
      title: "交流偏好",
      content: "用户喜欢直接、简洁的回答",
      kind: "preference",
      importance: 4
    });
    assert.equal(created.action, "created");
    assert.equal(created.item.title, "交流偏好");

    const updated = harness.store.upsertUserFact({
      userId: "user_1",
      memoryId: created.item.id,
      title: "交流偏好",
      content: "用户喜欢直接、简洁、带结论的回答",
      kind: "preference",
      importance: 5
    });
    assert.equal(updated.action, "updated_existing");
    assert.equal(updated.item.id, created.item.id);
    assert.equal(updated.item.createdAt, created.item.createdAt);
    assert.equal(updated.item.importance, 5);

    const facts = harness.store.listUserFacts("user_1");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.content, "用户喜欢直接、简洁、带结论的回答");

    const removed = harness.store.removeUserFact("user_1", created.item.id);
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.remaining, []);
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore updates same-slot user facts by specific title", async () => {
  const harness = await createContextStoreHarness();
  try {
    const created = harness.store.upsertUserFact({
      userId: "user_1",
      title: "早餐习惯",
      content: "早餐固定吃希腊酸奶加蓝莓和奇亚籽",
      kind: "habit"
    });

    const updated = harness.store.upsertUserFact({
      userId: "user_1",
      title: "早餐习惯",
      content: "早餐改成全麦吐司配牛油果，不再吃酸奶",
      kind: "habit"
    });

    assert.equal(updated.action, "updated_existing");
    assert.equal(updated.item.id, created.item.id);
    assert.equal(updated.dedup.matchedExistingId, created.item.id);
    const facts = harness.store.listUserFacts("user_1");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.content, "早餐改成全麦吐司配牛油果，不再吃酸奶");
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore removes facts without leaving related search chunks active", async () => {
  const harness = await createContextStoreHarness();
  try {
    const fact = harness.store.upsertUserFact({
      userId: "user_1",
      title: "早餐习惯",
      content: "早餐固定吃全麦吐司配牛油果，不再吃酸奶",
      kind: "habit"
    });
    harness.store.upsertUserSearchChunk({
      itemId: "ctx_breakfast_old",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      title: "近期用户消息",
      text: "用户：我早餐固定吃希腊酸奶加蓝莓和奇亚籽。",
      source: "user_explicit",
      createdAt: 100,
      updatedAt: 100
    });
    harness.store.upsertUserSearchChunk({
      itemId: "ctx_breakfast_new",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      title: "当前消息",
      text: "用户：更新一下，我早餐改成全麦吐司配牛油果，不再吃酸奶。",
      source: "user_explicit",
      createdAt: 200,
      updatedAt: 200
    });
    harness.store.upsertUserSearchChunk({
      itemId: "ctx_unrelated",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      text: "用户正在处理 Orama 检索链路",
      source: "system",
      createdAt: 300,
      updatedAt: 300
    });

    const removed = harness.store.removeUserFact("user_1", fact.item.id);

    assert.equal(removed.removed, true);
    assert.equal(removed.suppressedSearchCount, 2);
    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
    assert.deepEqual(harness.store.listUserSearchDocuments("user_1").map((item) => item.itemId), ["ctx_unrelated"]);
    const superseded = harness.store.listContextItems({ userId: "user_1", status: "superseded" }).items;
    assert.deepEqual(superseded.map((item) => item.itemId).sort(), ["ctx_breakfast_new", "ctx_breakfast_old"]);
    assert.ok(superseded.every((item) => item.supersededBy === fact.item.id));
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore resolves remove and replace by text only on unique matches", async () => {
  const harness = await createContextStoreHarness();
  try {
    const breakfast = harness.store.upsertUserFact({
      userId: "user_1",
      title: "早餐习惯",
      content: "早餐固定吃酸奶",
      kind: "habit"
    });
    harness.store.upsertUserFact({
      userId: "user_1",
      title: "咖啡偏好",
      content: "喜欢拿铁",
      kind: "preference"
    });

    const replaced = harness.store.replaceUserFactByText({
      userId: "user_1",
      query: "早餐",
      title: "早餐习惯",
      content: "早餐固定吃全麦吐司",
      kind: "habit"
    });
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.match?.id, breakfast.item.id);
    assert.equal(harness.store.listUserFacts("user_1").find((item) => item.id === breakfast.item.id)?.content, "早餐固定吃全麦吐司");

    const ambiguous = harness.store.removeUserFactByText("user_1", "偏好习惯");
    assert.equal(ambiguous.removed, false);
    assert.equal(ambiguous.reason, "ambiguous");
    assert.equal(harness.store.listUserFacts("user_1").length, 2);

    const removed = harness.store.removeUserFactByText("user_1", "咖啡");
    assert.equal(removed.removed, true);
    assert.equal(removed.match?.title, "咖啡偏好");
    assert.deepEqual(harness.store.listUserFacts("user_1").map((item) => item.title), ["早餐习惯"]);
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore keeps users and database files isolated", async () => {
  const left = await createContextStoreHarness();
  const right = await createContextStoreHarness();
  try {
    left.store.upsertUserFact({
      userId: "user_1",
      title: "早餐习惯",
      content: "早餐固定吃全麦吐司"
    });
    left.store.upsertUserFact({
      userId: "user_2",
      title: "早餐习惯",
      content: "早餐固定吃燕麦"
    });
    right.store.upsertUserFact({
      userId: "user_1",
      title: "早餐习惯",
      content: "早餐固定吃饭团"
    });

    assert.deepEqual(left.store.listUserFacts("user_1").map((item) => item.content), ["早餐固定吃全麦吐司"]);
    assert.deepEqual(left.store.listUserFacts("user_2").map((item) => item.content), ["早餐固定吃燕麦"]);
    assert.deepEqual(right.store.listUserFacts("user_1").map((item) => item.content), ["早餐固定吃饭团"]);
    assert.notEqual(left.store.getStatus().dbPath, right.store.getStatus().dbPath);
  } finally {
    await left.cleanup();
    await right.cleanup();
  }
});

test("ContextStore stores searchable user chunks separately from always-injected facts", async () => {
  const harness = await createContextStoreHarness();
  try {
    const fact = harness.store.upsertUserFact({
      userId: "user_1",
      title: "称呼",
      content: "用户希望被叫小王"
    });
    harness.store.upsertUserSearchChunk({
      itemId: "ctx_chunk_1",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      title: "近期消息",
      text: "用户正在处理 Orama 检索链路",
      source: "system",
      createdAt: 100,
      updatedAt: 200
    });

    assert.deepEqual(harness.store.listUserFacts("user_1").map((item) => item.id), [fact.item.id]);
    const documents = harness.store.listUserSearchDocuments("user_1");
    assert.equal(documents.length, 1);
    assert.equal(documents[0]?.itemId, "ctx_chunk_1");
    assert.equal(documents[0]?.retrievalPolicy, "search");
    assert.equal(documents[0]?.sourceType, "chunk");
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore stores raw messages idempotently", async () => {
  const harness = await createContextStoreHarness();
  try {
    harness.store.upsertRawMessages([{
      messageId: "raw_1",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      chatType: "private",
      role: "user",
      speakerId: "user_1",
      timestampMs: 100,
      text: "第一版内容",
      segments: [{ type: "text", data: { text: "第一版内容" } }],
      attachmentRefs: { imageIds: [] },
      sensitivity: "normal",
      ingestedAt: 101
    }]);
    harness.store.upsertRawMessages([{
      messageId: "raw_1",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      chatType: "private",
      role: "user",
      speakerId: "user_1",
      timestampMs: 100,
      text: "更新后的内容",
      sensitivity: "normal",
      ingestedAt: 102
    }]);

    harness.store.upsertUserSearchChunk({
      itemId: "ctx_after_raw",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      text: "raw 写入后仍可继续写 chunk",
      source: "system",
      createdAt: 100,
      updatedAt: 100
    });
    assert.equal(harness.store.listUserSearchDocuments("user_1")[0]?.itemId, "ctx_after_raw");
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore sweeps old and over-quota searchable user chunks", async () => {
  const harness = await createContextStoreHarness();
  try {
    for (let index = 0; index < 5; index += 1) {
      harness.store.upsertUserSearchChunk({
        itemId: `ctx_chunk_${index}`,
        userId: "user_1",
        sessionId: "qqbot:p:user_1",
        text: `检索片段 ${index}`,
        source: "system",
        createdAt: 100 + index,
        updatedAt: 100 + index
      });
    }
    harness.store.upsertUserSearchChunk({
      itemId: "ctx_other_user",
      userId: "user_2",
      sessionId: "qqbot:p:user_2",
      text: "其他用户片段",
      source: "system",
      createdAt: 1,
      updatedAt: 1
    });

    const swept = harness.store.sweepUserSearchChunks({
      userId: "user_1",
      maxChunks: 2,
      maxAgeMs: 3,
      now: 105
    });

    assert.equal(swept.deletedCount, 3);
    assert.deepEqual(
      harness.store.listUserSearchDocuments("user_1").map((item) => item.itemId),
      ["ctx_chunk_4", "ctx_chunk_3"]
    );
    assert.deepEqual(
      harness.store.listUserSearchDocuments("user_2").map((item) => item.itemId),
      ["ctx_other_user"]
    );
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore compacts old searchable chunks into summary and archives sources", async () => {
  const harness = await createContextStoreHarness();
  try {
    for (let index = 0; index < 3; index += 1) {
      harness.store.upsertUserSearchChunk({
        itemId: `ctx_old_${index}`,
        userId: "user_1",
        sessionId: "qqbot:p:user_1",
        title: `旧片段 ${index}`,
        text: `旧上下文 ${index}`,
        source: "system",
        createdAt: 100 + index,
        updatedAt: 100 + index
      });
    }

    const result = harness.store.compactUserSearchChunks({
      userId: "user_1",
      olderThanMs: 10,
      maxSourceChunks: 2,
      now: 200
    });

    assert.equal(result.compactedCount, 2);
    assert.ok(result.summaryItemId?.startsWith("ctx_summary_user_1_"));
    const active = harness.store.listContextItems({ userId: "user_1", status: "active" });
    assert.ok(active.items.some((item) => item.itemId === result.summaryItemId && item.sourceType === "summary"));
    assert.deepEqual(
      harness.store.listContextItems({ userId: "user_1", status: "archived" }).items.map((item) => item.itemId),
      ["ctx_old_1", "ctx_old_0"]
    );
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore supports stats, editing, bulk soft delete, deleted retention, and embedding reset", async () => {
  const harness = await createContextStoreHarness();
  try {
    const fact = harness.store.upsertUserFact({
      userId: "user_1",
      title: "偏好",
      content: "用户喜欢简洁回答"
    });
    harness.store.upsertUserSearchChunk({
      itemId: "ctx_chunk_edit",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      text: "待编辑片段",
      source: "system",
      createdAt: 100,
      updatedAt: 100
    });
    harness.store.upsertItemEmbedding({
      itemId: "ctx_chunk_edit",
      embeddingProfileId: "profile_1",
      vector: [1, 0, 0]
    });

    const edited = harness.store.updateContextItem({
      itemId: "ctx_chunk_edit",
      title: "编辑后标题",
      text: "编辑后片段",
      pinned: true,
      sensitivity: "private"
    });
    assert.equal(edited.updated, true);
    assert.equal(edited.item?.title, "编辑后标题");
    assert.equal(edited.item?.pinned, true);
    assert.equal(edited.item?.sensitivity, "private");

    const superseded = harness.store.updateContextItem({
      itemId: "ctx_chunk_edit",
      supersededBy: fact.item.id
    });
    assert.equal(superseded.item?.status, "superseded");
    assert.equal(superseded.item?.supersededBy, fact.item.id);
    assert.ok(superseded.item?.validTo);

    const stats = harness.store.getContextStats();
    assert.equal(stats.contextItems, 2);
    assert.equal(stats.embeddings, 1);
    assert.ok(stats.bySourceType.some((item) => item.sourceType === "chunk" && item.count === 1));

    const cleared = harness.store.clearEmbeddings({ userId: "user_1" });
    assert.equal(cleared.deletedCount, 1);
    assert.equal(harness.store.getContextStats().embeddings, 0);

    const deleted = harness.store.bulkDeleteContextItems({ userId: "user_1", sourceType: "chunk" });
    assert.equal(deleted.deletedCount, 1);
    assert.equal(harness.store.listContextItems({ userId: "user_1", status: "deleted" }).items[0]?.itemId, "ctx_chunk_edit");
    assert.equal(harness.store.listUserFacts("user_1")[0]?.id, fact.item.id);

    const swept = harness.store.sweepDeletedItems({
      deletedBeforeMs: 1,
      now: Date.now() + 10
    });
    assert.equal(swept.deletedCount, 1);
    assert.equal(harness.store.listContextItems({ userId: "user_1", status: "deleted" }).total, 0);
  } finally {
    await harness.cleanup();
  }
});

test("ContextStore excludes secret facts and search documents from prompt-facing reads", async () => {
  const harness = await createContextStoreHarness();
  try {
    const fact = harness.store.upsertUserFact({
      userId: "user_1",
      title: "普通事实",
      content: "可以进入 prompt"
    });
    harness.store.updateContextItem({
      itemId: fact.item.id,
      sensitivity: "secret"
    });
    harness.store.upsertUserSearchChunk({
      itemId: "ctx_secret_chunk",
      userId: "user_1",
      sessionId: "qqbot:p:user_1",
      text: "不应被检索",
      source: "system",
      createdAt: 100,
      updatedAt: 100
    });
    harness.store.updateContextItem({
      itemId: "ctx_secret_chunk",
      sensitivity: "secret"
    });

    assert.deepEqual(harness.store.listUserFacts("user_1"), []);
    assert.deepEqual(harness.store.listUserSearchDocuments("user_1"), []);
  } finally {
    await harness.cleanup();
  }
});

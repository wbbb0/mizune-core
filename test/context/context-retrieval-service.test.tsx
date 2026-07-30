import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ContextRetrievalService } from "../../src/context/contextRetrievalService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { ContextEmbeddingProfile, ContextSearchDocument } from "../../src/context/contextTypes.ts";

const profile: ContextEmbeddingProfile = {
  profileId: "embedding:test:fake:3:v1:user-facts-v1",
  instanceName: "test",
  provider: "embedding",
  model: "fake",
  dimension: 3,
  distance: "cosine",
  textPreprocessVersion: "v1",
  chunkerVersion: "user-facts-v1"
};

test("ContextRetrievalService retrieves indexed user context through Orama", async () => {
  const documents: ContextSearchDocument[] = [
    createDocument("ctx_1", "猫咪喜欢吃鱼"),
    createDocument("ctx_2", "终端命令需要先检查当前目录")
  ];
  const embeddings = new Map<string, number[]>();
  const store = {
    listUserSearchDocuments() {
      return documents;
    },
    upsertEmbeddingProfile() {},
    getItemEmbeddings(itemIds: string[]) {
      return new Map(itemIds.flatMap((itemId) => {
        const vector = embeddings.get(itemId);
        return vector ? [[itemId, vector] as const] : [];
      }));
    },
    upsertItemEmbedding(input: { itemId: string; vector: number[] }) {
      embeddings.set(input.itemId, input.vector);
    }
  };
  const embeddingService = {
    isAvailable() {
      return true;
    },
    async embedTexts(texts: string[]) {
      return {
        profile,
        vectors: texts.map(fakeVector)
      };
    }
  };

  const service = new ContextRetrievalService(
    createTestAppConfig(),
    store as any,
    embeddingService as any,
    pino({ level: "silent" })
  );
  const results = await service.retrieveUserContext({
    userId: "user_1",
    queryText: "猫吃什么"
  });

  assert.equal(results[0]?.itemId, "ctx_1");
  assert.equal(embeddings.size, 2);
  const debugReport = service.getLastDebugReport();
  assert.equal(debugReport?.candidateCount, 2);
  assert.equal(debugReport?.indexedCount, 2);
  assert.equal(debugReport?.selectedCount, results.length);
  assert.ok(results.length >= 1);
});

test("ContextRetrievalService records prompt memory reports per session", () => {
  const promptedBatches: string[][] = [];
  const service = new ContextRetrievalService(
    createTestAppConfig(),
    {
      recordPromptedContextItems(input: { itemIds: Iterable<string> }) {
        promptedBatches.push(Array.from(input.itemIds));
        return 0;
      }
    } as any,
    { isAvailable: () => false } as any,
    pino({ level: "silent" })
  );

  service.recordPromptMemoryReport({
    sessionId: "session_a",
    modeId: "normal",
    userId: "user_1",
    queryText: "此会话专门用于测试 Orama 记忆",
    currentUserMemories: [{
      id: "mem_user_1",
      title: "测试偏好",
      content: "用户喜欢用 Orama 检索记忆",
      kind: "preference",
      source: "user_explicit",
      createdAt: 1,
      updatedAt: 2,
      importance: 4,
      slotKey: "preference:retrieval"
    }],
    availableUserFactCount: 2,
    userFactLimit: 1,
    currentSessionContext: [{
      id: "mem_session_1",
      title: "会话用途",
      content: "此会话专门用于记忆系统测试",
      kind: "fact",
      source: "inferred",
      createdAt: 1,
      updatedAt: 3
    }],
    availableSessionFactCount: 1,
    sessionFactLimit: 20,
    retrievedUserContext: [{
      itemId: "ctx_1",
      scope: "user",
      layer: "episode",
      subjectKind: "user",
      subjectId: "user_1",
      sourceType: "chunk",
      text: "用户之前在调试 SQLite 迁移",
      score: 0.83,
      updatedAt: 4
    }],
    semanticRetrievalAttempted: true
  });
  service.recordPromptMemoryReport({
    sessionId: "session_b",
    queryText: "",
    currentUserMemories: [],
    availableUserFactCount: 0,
    userFactLimit: 1,
    currentSessionContext: [],
    availableSessionFactCount: 0,
    sessionFactLimit: 20,
    retrievedUserContext: [],
    semanticRetrievalAttempted: false,
    semanticRetrievalSkippedReason: "missing_user"
  });

  const firstReport = service.getLastPromptMemoryReport({ sessionId: "session_a" });
  assert.equal(firstReport?.selectedCount, 3);
  assert.equal(firstReport?.currentUserFactCount, 1);
  assert.equal(firstReport?.availableUserFactCount, 2);
  assert.equal(firstReport?.userFactTruncated, true);
  assert.equal(firstReport?.currentSessionFactCount, 1);
  assert.equal(firstReport?.sessionFactTruncated, false);
  assert.equal(firstReport?.retrievedUserContext[0]?.entrySource, "semantic_retrieval");
  assert.deepEqual(promptedBatches[0], ["mem_user_1", "mem_session_1", "ctx_1"]);
  assert.deepEqual(promptedBatches[1], []);
  assert.equal(service.getLastPromptMemoryReport({ sessionId: "session_b" })?.semanticRetrieval.skippedReason, "missing_user");
});

test("ContextRetrievalService returns always user context without embedding", async () => {
  const retrievedBatches: string[][] = [];
  const service = new ContextRetrievalService(
    createTestAppConfig({
      context: {
        retrieval: {
          maxResults: 1
        }
      }
    }),
    {
      listUserAlwaysDocuments() {
        return [
          createDocument("fact_1", "普通低相关事实", "always"),
          createDocument("fact_2", "我的测试暗号是蓝色火花", "always")
        ];
      },
      listUserSearchDocuments() {
        return [createDocument("ctx_1", "猫咪喜欢吃鱼")];
      },
      recordRetrievedContextItems(input: { itemIds: Iterable<string> }) {
        retrievedBatches.push(Array.from(input.itemIds));
        return 0;
      }
    } as any,
    {
      isAvailable() {
        return false;
      }
    } as any,
    pino({ level: "silent" })
  );

  const results = await service.retrieveUserContext({
    userId: "user_1",
    queryText: "我的测试暗号是什么"
  });

  assert.deepEqual(results.map((item) => item.itemId), ["fact_2"]);
  assert.deepEqual(retrievedBatches, [["fact_2"]]);
  assert.equal(service.getLastDebugReport()?.error, "embedding is not configured; returned always context only");
  assert.equal(service.getLastDebugReport()?.droppedCount, 1);
});

test("ContextRetrievalService fails open when embedding is unavailable", async () => {
  const service = new ContextRetrievalService(
    createTestAppConfig(),
    {
      listUserAlwaysDocuments() {
        return [];
      },
      listUserSearchDocuments() {
        return [createDocument("ctx_1", "猫咪喜欢吃鱼")];
      }
    } as any,
    {
      isAvailable() {
        return true;
      },
      async embedTexts() {
        throw new Error("embedding down");
      }
    } as any,
    pino({ level: "silent" })
  );

  assert.deepEqual(await service.retrieveUserContext({
    userId: "user_1",
    queryText: "猫"
  }), []);
});

test("ContextRetrievalService keeps always facts when embedding search fails", async () => {
  const service = new ContextRetrievalService(
    createTestAppConfig(),
    {
      listUserAlwaysDocuments() {
        return [createDocument("fact_1", "我的早餐习惯是全麦吐司配牛油果", "always")];
      },
      listUserSearchDocuments() {
        return [createDocument("ctx_1", "旧早餐是酸奶")];
      }
    } as any,
    {
      isAvailable() {
        return true;
      },
      async embedTexts() {
        throw new Error("embedding timeout");
      }
    } as any,
    pino({ level: "silent" })
  );

  const results = await service.retrieveUserContext({
    userId: "user_1",
    queryText: "我早餐吃什么"
  });

  assert.deepEqual(results.map((item) => item.itemId), ["fact_1"]);
  assert.equal(service.getLastDebugReport()?.error, "embedding timeout");
});

test("ContextRetrievalService limits synchronous document embedding on prompt path", async () => {
  const documents: ContextSearchDocument[] = [
    createDocument("ctx_1", "第一条"),
    createDocument("ctx_2", "第二条"),
    createDocument("ctx_3", "第三条")
  ];
  const embeddedTexts: string[][] = [];
  const embeddings = new Map<string, number[]>();
  const service = new ContextRetrievalService(
    createTestAppConfig({
      context: {
        retrieval: {
          maxSynchronousEmbeddingDocuments: 1
        }
      }
    }),
    {
      listUserSearchDocuments() {
        return documents;
      },
      upsertEmbeddingProfile() {},
      getItemEmbeddings(itemIds: string[]) {
        return new Map(itemIds.flatMap((itemId) => {
          const vector = embeddings.get(itemId);
          return vector ? [[itemId, vector] as const] : [];
        }));
      },
      upsertItemEmbedding(input: { itemId: string; vector: number[] }) {
        embeddings.set(input.itemId, input.vector);
      }
    } as any,
    {
      isAvailable() {
        return true;
      },
      async embedTexts(texts: string[]) {
        embeddedTexts.push(texts);
        return {
          profile,
          vectors: texts.map(fakeVector)
        };
      }
    } as any,
    pino({ level: "silent" })
  );

  await service.retrieveUserContext({
    userId: "user_1",
    queryText: "第一条"
  });

  assert.deepEqual(embeddedTexts, [["第一条"], ["第一条"]]);
  assert.deepEqual(Array.from(embeddings.keys()), ["ctx_1"]);
});

test("ContextRetrievalService rebuilds user indexes and batches background embedding", async () => {
  const documents: ContextSearchDocument[] = [
    createDocument("ctx_1", "猫咪喜欢吃鱼"),
    createDocument("ctx_2", "终端命令需要先检查当前目录"),
    createDocument("ctx_3", "第三条")
  ];
  const embeddings = new Map<string, number[]>();
  const embeddedTexts: string[][] = [];
  const service = new ContextRetrievalService(
    createTestAppConfig(),
    {
      listUserIdsWithSearchDocuments() {
        return ["user_1"];
      },
      listUserSearchDocuments() {
        return documents;
      },
      upsertEmbeddingProfile() {},
      getItemEmbeddings(itemIds: string[]) {
        return new Map(itemIds.flatMap((itemId) => {
          const vector = embeddings.get(itemId);
          return vector ? [[itemId, vector] as const] : [];
        }));
      },
      upsertItemEmbedding(input: { itemId: string; vector: number[] }) {
        embeddings.set(input.itemId, input.vector);
      }
    } as any,
    {
      isAvailable() {
        return true;
      },
      async embedTexts(texts: string[]) {
        embeddedTexts.push(texts);
        return {
          profile,
          vectors: texts.map(fakeVector)
        };
      }
    } as any,
    pino({ level: "silent" })
  );

  const result = await service.rebuildUserIndexes({
    embeddingBatchSize: 2
  });

  assert.deepEqual(embeddedTexts, [["上下文索引维护"], ["猫咪喜欢吃鱼", "终端命令需要先检查当前目录"]]);
  assert.equal(result.userCount, 1);
  assert.equal(result.embeddedCount, 2);
  assert.equal(result.indexedCount, 2);
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(Array.from(embeddings.keys()), ["ctx_1", "ctx_2"]);
});

test("ContextRetrievalService skips all rebuild work while embedding is unavailable", async () => {
  let listedUsers = false;
  const service = new ContextRetrievalService(
    createTestAppConfig(),
    {
      listUserIdsWithSearchDocuments() {
        listedUsers = true;
        return ["user_1"];
      }
    } as any,
    {
      isAvailable() {
        return false;
      }
    } as any,
    pino({ level: "silent" })
  );

  assert.deepEqual(await service.rebuildUserIndexes(), {
    userCount: 0,
    embeddedCount: 0,
    indexedCount: 0,
    skippedCount: 0,
    errors: [],
    unavailableReason: "embedding_unavailable"
  });
  assert.equal(listedUsers, false);
});

function createDocument(
  itemId: string,
  text: string,
  retrievalPolicy: ContextSearchDocument["retrievalPolicy"] = "search"
): ContextSearchDocument {
  return {
    itemId,
    scope: "user",
    layer: retrievalPolicy === "always" ? "core_fact" : "episode",
    subjectKind: "user",
    subjectId: "user_1",
    sourceType: "chunk",
    retrievalPolicy,
    userId: "user_1",
    text,
    embeddingTextHash: `hash:${text}`,
    updatedAt: 1
  };
}

function fakeVector(text: string): number[] {
  if (text.includes("猫") || text.includes("鱼")) {
    return [1, 0, 0];
  }
  if (text.includes("终端") || text.includes("目录")) {
    return [0, 1, 0];
  }
  return [0, 0, 1];
}

import assert from "node:assert/strict";
import test from "node:test";

import { contextChunk, OramaHybridContextRetriever } from "../src/retriever.mjs";

class StaticEmbeddingClient {
  constructor(vectors) {
    this.vectors = vectors;
  }

  async embedTexts(texts) {
    return texts.map((text) => {
      const vector = this.vectors[text];
      if (!vector) {
        throw new Error(`missing static embedding for: ${text}`);
      }
      return vector;
    });
  }
}

function chunk({ chunkId, userId, sessionId, sourceType, createdAt, text }) {
  return contextChunk({
    chunkId,
    userId,
    sessionId,
    sourceType,
    createdAt,
    text,
  });
}

test("limits results to the current user", async () => {
  const retriever = new OramaHybridContextRetriever({
    embeddingClient: new StaticEmbeddingClient({
      "我喜欢无糖拿铁和冷萃。": [1, 0, 0],
      "我下个月准备去东京出差。": [0.2, 0.2, 0.8],
      "我最喜欢吃重庆火锅。": [1, 0, 0],
      "今天继续聊咖啡偏好。": [0.9, 0, 0.1],
    }),
  });
  await retriever.indexChunks([
    chunk({
      chunkId: "a1",
      userId: "alice",
      sessionId: "s1",
      sourceType: "chunk",
      createdAt: "2026-04-01T09:00:00Z",
      text: "我喜欢无糖拿铁和冷萃。",
    }),
    chunk({
      chunkId: "a2",
      userId: "alice",
      sessionId: "s2",
      sourceType: "summary",
      createdAt: "2026-04-02T09:00:00Z",
      text: "我下个月准备去东京出差。",
    }),
    chunk({
      chunkId: "b1",
      userId: "bob",
      sessionId: "s9",
      sourceType: "chunk",
      createdAt: "2026-04-03T09:00:00Z",
      text: "我最喜欢吃重庆火锅。",
    }),
  ]);

  const results = await retriever.retrieve({
    userId: "alice",
    queryText: "今天继续聊咖啡偏好。",
    limit: 3,
  });

  assert.deepEqual(results.map((item) => item.chunkId), ["a1", "a2"]);
  assert.ok(results.every((item) => item.userId === "alice"));
});

test("uses recency to break close hybrid matches", async () => {
  const retriever = new OramaHybridContextRetriever({
    embeddingClient: new StaticEmbeddingClient({
      "我希望你以后叫我阿斌。": [1, 0, 0],
      "你可以直接叫我阿斌。": [1, 0, 0],
      "以后怎么称呼我来着？": [1, 0, 0],
    }),
  });
  await retriever.indexChunks([
    chunk({
      chunkId: "old",
      userId: "alice",
      sessionId: "s1",
      sourceType: "chunk",
      createdAt: "2026-01-01T09:00:00Z",
      text: "我希望你以后叫我阿斌。",
    }),
    chunk({
      chunkId: "new",
      userId: "alice",
      sessionId: "s2",
      sourceType: "chunk",
      createdAt: "2026-04-10T09:00:00Z",
      text: "你可以直接叫我阿斌。",
    }),
  ]);

  const results = await retriever.retrieve({
    userId: "alice",
    queryText: "以后怎么称呼我来着？",
    limit: 2,
  });

  assert.deepEqual(results.map((item) => item.chunkId), ["new", "old"]);
});

test("debug keeps relevant items ahead of same-user noise", async () => {
  const retriever = new OramaHybridContextRetriever({
    embeddingClient: new StaticEmbeddingClient({
      "如果你给我推荐咖啡，优先无糖冷萃。": [0.98, 0.02, 0],
      "以后直接叫我阿斌。": [0.82, 0.18, 0],
      "回答先给结论，再给简短步骤。": [0.76, 0.24, 0],
      "我六月去东京出差，酒店已经订好了。": [0.3, 0.7, 0],
      "今晚继续刷赛博朋克的新档。": [0.2, 0.8, 0],
      "我喜欢无糖冰美式。": [0.99, 0.01, 0],
      "今天给我推荐一杯咖啡，记得叫我阿斌，回答简短。": [0.9, 0.1, 0],
    }),
  });
  await retriever.indexChunks([
    chunk({
      chunkId: "coffee",
      userId: "alice",
      sessionId: "s1",
      sourceType: "chunk",
      createdAt: "2026-04-01T09:00:00Z",
      text: "如果你给我推荐咖啡，优先无糖冷萃。",
    }),
    chunk({
      chunkId: "address",
      userId: "alice",
      sessionId: "s2",
      sourceType: "chunk",
      createdAt: "2026-04-03T09:00:00Z",
      text: "以后直接叫我阿斌。",
    }),
    chunk({
      chunkId: "style",
      userId: "alice",
      sessionId: "s3",
      sourceType: "summary",
      createdAt: "2026-04-07T09:00:00Z",
      text: "回答先给结论，再给简短步骤。",
    }),
    chunk({
      chunkId: "travel-noise",
      userId: "alice",
      sessionId: "s4",
      sourceType: "chunk",
      createdAt: "2026-04-08T09:00:00Z",
      text: "我六月去东京出差，酒店已经订好了。",
    }),
    chunk({
      chunkId: "gaming-noise",
      userId: "alice",
      sessionId: "s5",
      sourceType: "chunk",
      createdAt: "2026-04-09T09:00:00Z",
      text: "今晚继续刷赛博朋克的新档。",
    }),
    chunk({
      chunkId: "bob-confuser",
      userId: "bob",
      sessionId: "s9",
      sourceType: "summary",
      createdAt: "2026-04-10T09:00:00Z",
      text: "我喜欢无糖冰美式。",
    }),
  ]);

  const debug = await retriever.retrieveDebug({
    userId: "alice",
    queryText: "今天给我推荐一杯咖啡，记得叫我阿斌，回答简短。",
    limit: 3,
  });

  assert.deepEqual(new Set(debug.selected.map((item) => item.chunkId)), new Set(["coffee", "style", "address"]));
  assert.ok(debug.candidates.every((item) => item.userId === "alice"));
  assert.ok(new Set(debug.dropped.map((item) => item.chunkId)).has("travel-noise"));
  assert.ok(new Set(debug.dropped.map((item) => item.chunkId)).has("gaming-noise"));
});

test("debug marks selected and dropped candidates", async () => {
  const retriever = new OramaHybridContextRetriever({
    embeddingClient: new StaticEmbeddingClient({
      "以后叫我阿斌。": [1, 0, 0],
      "你直接叫我阿斌。": [0.96, 0.04, 0],
      "我住在上海浦东。": [0.99, 0.01, 0],
      "我最近在整理 NAS。": [0.05, 0.95, 0],
      "以后怎么称呼我，顺便记一下我住在哪。": [0.92, 0.08, 0],
    }),
  });
  await retriever.indexChunks([
    chunk({
      chunkId: "address",
      userId: "alice",
      sessionId: "s1",
      sourceType: "chunk",
      createdAt: "2026-04-01T09:00:00Z",
      text: "我住在上海浦东。",
    }),
    chunk({
      chunkId: "name-old",
      userId: "alice",
      sessionId: "s2",
      sourceType: "chunk",
      createdAt: "2026-04-02T09:00:00Z",
      text: "以后叫我阿斌。",
    }),
    chunk({
      chunkId: "name-new",
      userId: "alice",
      sessionId: "s3",
      sourceType: "summary",
      createdAt: "2026-04-08T09:00:00Z",
      text: "你直接叫我阿斌。",
    }),
    chunk({
      chunkId: "nas-noise",
      userId: "alice",
      sessionId: "s4",
      sourceType: "chunk",
      createdAt: "2026-04-09T09:00:00Z",
      text: "我最近在整理 NAS。",
    }),
  ]);

  const debug = await retriever.retrieveDebug({
    userId: "alice",
    queryText: "以后怎么称呼我，顺便记一下我住在哪。",
    limit: 2,
  });

  assert.equal(debug.candidates.filter((item) => item.selected).length, 2);
  assert.deepEqual(new Set(debug.selected.map((item) => item.chunkId)), new Set(["name-new", "address"]));
  assert.deepEqual(new Set(debug.dropped.map((item) => item.chunkId)), new Set(["name-old", "nas-noise"]));
});

test("debug exposes candidate ranks for reasoning output", async () => {
  const retriever = new OramaHybridContextRetriever({
    embeddingClient: new StaticEmbeddingClient({
      "咖啡只喝无糖。": [0.95, 0.05, 0],
      "回答尽量简短。": [0.85, 0.15, 0],
      "我周末想重装电脑。": [0.83, 0.17, 0],
      "推荐咖啡时记得简短一点。": [0.9, 0.1, 0],
    }),
  });
  await retriever.indexChunks([
    chunk({
      chunkId: "coffee",
      userId: "alice",
      sessionId: "s1",
      sourceType: "chunk",
      createdAt: "2026-04-01T09:00:00Z",
      text: "咖啡只喝无糖。",
    }),
    chunk({
      chunkId: "style",
      userId: "alice",
      sessionId: "s2",
      sourceType: "summary",
      createdAt: "2026-04-03T09:00:00Z",
      text: "回答尽量简短。",
    }),
    chunk({
      chunkId: "pc-noise",
      userId: "alice",
      sessionId: "s3",
      sourceType: "chunk",
      createdAt: "2026-04-04T09:00:00Z",
      text: "我周末想重装电脑。",
    }),
  ]);

  const debug = await retriever.retrieveDebug({
    userId: "alice",
    queryText: "推荐咖啡时记得简短一点。",
    limit: 2,
  });

  assert.deepEqual(debug.candidates.map((item) => item.candidateRank), [1, 2, 3]);
  assert.ok(debug.candidates[0].finalScore >= debug.candidates[1].finalScore);
  assert.ok(debug.candidates[1].finalScore >= debug.candidates[2].finalScore);
});

test("debug skips near duplicate hits in selected results", async () => {
  const retriever = new OramaHybridContextRetriever({
    embeddingClient: new StaticEmbeddingClient({
      "回答先给结论，再给简短步骤。": [0.95, 0.05, 0],
      "回答尽量先说结论，再给很短的步骤。": [0.93, 0.07, 0],
      "推荐咖啡优先无糖冷萃。": [0.82, 0.18, 0],
      "今天推荐咖啡时记得回答简短。": [0.9, 0.1, 0],
    }),
  });
  await retriever.indexChunks([
    chunk({
      chunkId: "style-a",
      userId: "alice",
      sessionId: "s1",
      sourceType: "chunk",
      createdAt: "2026-04-03T09:00:00Z",
      text: "回答先给结论，再给简短步骤。",
    }),
    chunk({
      chunkId: "style-b",
      userId: "alice",
      sessionId: "s2",
      sourceType: "chunk",
      createdAt: "2026-04-04T09:00:00Z",
      text: "回答尽量先说结论，再给很短的步骤。",
    }),
    chunk({
      chunkId: "coffee",
      userId: "alice",
      sessionId: "s3",
      sourceType: "summary",
      createdAt: "2026-04-05T09:00:00Z",
      text: "推荐咖啡优先无糖冷萃。",
    }),
  ]);

  const debug = await retriever.retrieveDebug({
    userId: "alice",
    queryText: "今天推荐咖啡时记得回答简短。",
    limit: 2,
  });

  const selectedIds = new Set(debug.selected.map((item) => item.chunkId));
  const droppedIds = new Set(debug.dropped.map((item) => item.chunkId));

  assert.ok(selectedIds.has("coffee"));
  assert.ok(selectedIds.has("style-a") || selectedIds.has("style-b"));
  assert.ok(droppedIds.has("style-a") || droppedIds.has("style-b"));
});

import { create, insertMultiple, search } from "@orama/orama";

import { createMixedLanguageTokenizer, lexicalOverlap, textOverlapRatio } from "./tokenizer.mjs";

export const ORAMA_HYBRID_WEIGHT = 0.83;
export const RECENCY_WEIGHT = 0.15;
export const SUMMARY_BONUS = 0.02;
export const NEAR_DUPLICATE_THRESHOLD = 0.3;

export class OramaHybridContextRetriever {
  constructor({ embeddingClient }) {
    this.embeddingClient = embeddingClient;
    this.db = null;
    this.vectorSize = null;
  }

  async indexChunks(chunks) {
    if (chunks.length === 0) {
      return;
    }
    const embeddings = await this.embeddingClient.embedTexts(chunks.map((chunk) => chunk.text));
    if (embeddings.length !== chunks.length) {
      throw new Error(`embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`);
    }
    const vectorSize = embeddings[0]?.length;
    if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
      throw new Error("embedding provider returned an empty vector");
    }
    this.ensureDatabase(vectorSize);
    const documents = chunks.map((chunk, index) => ({
      id: chunk.chunkId,
      chunk_id: chunk.chunkId,
      user_id: chunk.userId,
      session_id: chunk.sessionId,
      source_type: chunk.sourceType,
      created_at_iso: chunk.createdAt.toISOString(),
      created_at_ms: chunk.createdAt.getTime(),
      text: chunk.text,
      embedding: embeddings[index],
    }));
    await insertMultiple(this.db, documents);
  }

  async retrieve({ userId, queryText, limit = 5 }) {
    const debug = await this.retrieveDebug({ userId, queryText, limit });
    return debug.selected;
  }

  async retrieveDebug({ userId, queryText, limit = 5 }) {
    if (!this.db) {
      return {
        userId,
        queryText,
        limit,
        selected: [],
        dropped: [],
        candidates: [],
      };
    }

    const [queryVector] = await this.embeddingClient.embedTexts([queryText]);
    const response = await search(this.db, {
      mode: "hybrid",
      term: queryText,
      vector: {
        value: queryVector,
        property: "embedding",
      },
      properties: ["text"],
      where: {
        user_id: userId,
      },
      limit: Math.max(limit * 4, limit),
      similarity: 0,
      threshold: 0,
      hybridWeights: {
        vector: 0.72,
        text: 0.28,
      },
      includeVectors: false,
    });

    if (response.hits.length === 0) {
      return {
        userId,
        queryText,
        limit,
        selected: [],
        dropped: [],
        candidates: [],
      };
    }

    const timestamps = response.hits.map((hit) => Number(hit.document.created_at_ms));
    const minTimestamp = Math.min(...timestamps);
    const maxTimestamp = Math.max(...timestamps);

    const rankedItems = response.hits.map((hit) => {
      const document = hit.document;
      const createdAt = new Date(document.created_at_iso);
      const sourceType = String(document.source_type);
      const lexicalScore = lexicalOverlap(queryText, String(document.text));
      const recencyScore = normalizeTimestamp(Number(document.created_at_ms), minTimestamp, maxTimestamp);
      const oramaScore = Number(hit.score);
      const sourceBonus = sourceType === "summary" ? SUMMARY_BONUS : 0;
      const finalScore = oramaScore * ORAMA_HYBRID_WEIGHT + recencyScore * RECENCY_WEIGHT + sourceBonus;
      return {
        chunkId: String(document.chunk_id),
        userId: String(document.user_id),
        sessionId: String(document.session_id),
        sourceType,
        createdAt,
        text: String(document.text),
        oramaScore,
        lexicalScore,
        recencyScore,
        sourceBonus,
        finalScore,
        candidateRank: 0,
        selected: false,
        dropReason: undefined,
      };
    });

    rankedItems.sort((a, b) => (
      b.finalScore - a.finalScore
      || b.recencyScore - a.recencyScore
      || b.lexicalScore - a.lexicalScore
      || b.createdAt.getTime() - a.createdAt.getTime()
    ));

    const rankedCandidates = rankedItems.map((item, index) => ({
      ...item,
      candidateRank: index + 1,
    }));
    const { selectedIds, dropReasons } = chooseSelectedCandidates(rankedCandidates, limit);
    const candidates = rankedCandidates.map((item) => {
      const selected = selectedIds.has(item.chunkId);
      return {
        ...item,
        selected,
        dropReason: selected ? undefined : (dropReasons.get(item.chunkId) ?? "score-cutoff"),
      };
    });

    return {
      userId,
      queryText,
      limit,
      selected: candidates.filter((item) => item.selected),
      dropped: candidates.filter((item) => !item.selected),
      candidates,
    };
  }

  reset() {
    this.db = null;
    this.vectorSize = null;
  }

  ensureDatabase(vectorSize) {
    if (this.db) {
      if (this.vectorSize !== vectorSize) {
        throw new Error(`embedding vector size changed: expected ${this.vectorSize}, got ${vectorSize}`);
      }
      return;
    }
    this.vectorSize = vectorSize;
    this.db = create({
      schema: {
        id: "string",
        chunk_id: "string",
        user_id: "string",
        session_id: "string",
        source_type: "string",
        created_at_iso: "string",
        created_at_ms: "number",
        text: "string",
        embedding: `vector[${vectorSize}]`,
      },
      components: {
        tokenizer: createMixedLanguageTokenizer(),
      },
    });
  }
}

export function contextChunk({ chunkId, userId, sessionId, sourceType, createdAt, text }) {
  return {
    chunkId,
    userId,
    sessionId,
    sourceType,
    createdAt: toDate(createdAt),
    text,
  };
}

export function toDate(value) {
  if (value instanceof Date) {
    return value;
  }
  return new Date(String(value).replace("Z", "+00:00"));
}

export function normalizeTimestamp(value, minTimestamp, maxTimestamp) {
  if (maxTimestamp <= minTimestamp) {
    return 1;
  }
  return (value - minTimestamp) / (maxTimestamp - minTimestamp);
}

export function chooseSelectedCandidates(candidates, limit) {
  const selected = [];
  const dropReasons = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const duplicateWith = selected.find(
      (previous) => textOverlapRatio(candidate.text, previous.text) >= NEAR_DUPLICATE_THRESHOLD,
    );
    const remainingCandidates = candidates.length - (index + 1);
    const slotsLeft = limit - selected.length;
    if (duplicateWith && remainingCandidates >= slotsLeft) {
      dropReasons.set(candidate.chunkId, `near-duplicate:${duplicateWith.chunkId}`);
      continue;
    }
    if (selected.length < limit) {
      selected.push(candidate);
      continue;
    }
    dropReasons.set(candidate.chunkId, "score-cutoff");
  }
  return {
    selectedIds: new Set(selected.map((item) => item.chunkId)),
    dropReasons,
  };
}

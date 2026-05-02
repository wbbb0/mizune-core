import type { Logger } from "pino";
import { createHash } from "node:crypto";
import type { AppConfig } from "#config/config.ts";
import { ContextEmbeddingService } from "./contextEmbeddingService.ts";
import { selectRetrievedUserContext } from "./contextSelectionPolicy.ts";
import type { ContextStore } from "./contextStore.ts";
import { OramaContextIndex } from "./oramaContextIndex.ts";
import type { ContextRetrievalDebugReport, ContextRetrievedItem, ContextSearchDocument } from "./contextTypes.ts";

export class ContextRetrievalService {
  private readonly userIndexes = new Map<string, OramaContextIndex>();
  private lastDebugReport: ContextRetrievalDebugReport | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly contextStore: ContextStore,
    private readonly embeddingService: ContextEmbeddingService,
    private readonly logger: Logger
  ) { }

  async retrieveUserContext(input: {
    userId: string;
    queryText: string;
    excludeItemIds?: Iterable<string>;
    abortSignal?: AbortSignal;
  }): Promise<ContextRetrievedItem[]> {
    const queryText = input.queryText.trim();
    const excludeItemIds = new Set(input.excludeItemIds ?? []);
    const alwaysDocuments = (this.contextStore.listUserAlwaysDocuments?.(input.userId) ?? [])
      .filter((item) => !excludeItemIds.has(item.itemId));
    const alwaysItems = alwaysDocuments.map(toAlwaysRetrievedItem);
    if (!queryText) {
      this.lastDebugReport = {
        userId: input.userId,
        queryText,
        candidateCount: alwaysDocuments.length,
        indexedCount: 0,
        selectedCount: alwaysItems.length,
        droppedCount: 0,
        error: "empty query",
        createdAt: Date.now()
      };
      return alwaysItems;
    }
    if (!this.embeddingService.isConfigured()) {
      this.lastDebugReport = {
        userId: input.userId,
        queryText,
        candidateCount: alwaysDocuments.length,
        indexedCount: 0,
        selectedCount: alwaysItems.length,
        droppedCount: 0,
        error: alwaysItems.length > 0 ? "embedding is not configured; returned always context only" : "embedding is not configured",
        createdAt: Date.now()
      };
      return alwaysItems;
    }
    try {
      const documents = this.contextStore
        .listUserSearchDocuments(input.userId)
        .filter((item) => !excludeItemIds.has(item.itemId));
      if (documents.length === 0) {
        this.lastDebugReport = {
          userId: input.userId,
          queryText,
          candidateCount: alwaysDocuments.length,
          indexedCount: 0,
          selectedCount: alwaysItems.length,
          droppedCount: 0,
          createdAt: Date.now()
        };
        return alwaysItems;
      }
      const queryEmbedding = await this.embeddingService.embedTexts([queryText], {
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });
      const profile = queryEmbedding.profile;
      this.contextStore.upsertEmbeddingProfile(profile);
      const storedEmbeddings = this.contextStore.getItemEmbeddings(
        documents.map((item) => item.itemId),
        profile.profileId
      );
      const missingDocuments = documents
        .filter((item) => !storedEmbeddings.has(item.itemId))
        .slice(0, this.config.context.retrieval.maxSynchronousEmbeddingDocuments);
      if (missingDocuments.length > 0) {
        const embeddedDocuments = await this.embeddingService.embedTexts(
          missingDocuments.map((item) => item.text),
          {
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
          }
        );
        if (embeddedDocuments.profile.profileId !== profile.profileId) {
          throw new Error("Embedding profile changed during context indexing");
        }
        for (let index = 0; index < missingDocuments.length; index += 1) {
          const document = missingDocuments[index];
          const vector = embeddedDocuments.vectors[index];
          if (!document || !vector) {
            continue;
          }
          this.contextStore.upsertItemEmbedding({
            itemId: document.itemId,
            embeddingProfileId: profile.profileId,
            vector
          });
          storedEmbeddings.set(document.itemId, vector);
        }
      }

      const indexedDocuments = documents
        .map((document) => {
          const embedding = storedEmbeddings.get(document.itemId);
          return embedding ? { ...document, embedding } : null;
        })
        .filter((item): item is ContextSearchDocument & { embedding: number[] } => item != null);
      if (indexedDocuments.length === 0) {
        this.lastDebugReport = {
          userId: input.userId,
          queryText,
          embeddingProfileId: profile.profileId,
          candidateCount: documents.length,
          indexedCount: 0,
          selectedCount: 0,
          droppedCount: documents.length,
          createdAt: Date.now()
        };
        return [];
      }
      const index = this.getUserIndex(input.userId);
      await index.rebuild({
        signature: buildIndexSignature(profile.profileId, indexedDocuments),
        documents: indexedDocuments
      });
      const searchCandidates = await index.search({
        userId: input.userId,
        queryText,
        queryVector: queryEmbedding.vectors[0] ?? [],
        limit: Math.max(0, this.config.context.retrieval.maxResults - alwaysItems.length),
        candidateMultiplier: this.config.context.retrieval.candidateMultiplier,
        minScore: this.config.context.retrieval.minScore
      });
      const results = selectRetrievedUserContext({
        queryText,
        alwaysItems,
        searchItems: searchCandidates,
        maxResults: this.config.context.retrieval.maxResults
      });
      this.lastDebugReport = {
        userId: input.userId,
        queryText,
        embeddingProfileId: profile.profileId,
        candidateCount: alwaysDocuments.length + documents.length,
        indexedCount: indexedDocuments.length,
        selectedCount: results.length,
        droppedCount: Math.max(0, indexedDocuments.length - (results.length - alwaysItems.length)),
        createdAt: Date.now()
      };
      return results;
    } catch (error) {
      this.lastDebugReport = {
        userId: input.userId,
        queryText,
        candidateCount: alwaysDocuments.length,
        indexedCount: 0,
        selectedCount: alwaysItems.length,
        droppedCount: 0,
        error: error instanceof Error ? error.message : String(error),
        createdAt: Date.now()
      };
      this.logger.warn({
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error)
      }, "context_retrieval_failed_open");
      return alwaysItems;
    }
  }

  private getUserIndex(userId: string): OramaContextIndex {
    const existing = this.userIndexes.get(userId);
    if (existing) {
      return existing;
    }
    const index = new OramaContextIndex();
    this.userIndexes.set(userId, index);
    return index;
  }

  resetIndexes(input?: { userId?: string }): {
    resetCount: number;
  } {
    if (input?.userId) {
      const existing = this.userIndexes.get(input.userId);
      if (!existing) {
        return { resetCount: 0 };
      }
      existing.reset();
      this.userIndexes.delete(input.userId);
      this.logger.info({ userId: input.userId }, "context_user_index_reset");
      return { resetCount: 1 };
    }
    const resetCount = this.userIndexes.size;
    for (const index of this.userIndexes.values()) {
      index.reset();
    }
    this.userIndexes.clear();
    if (resetCount > 0) {
      this.logger.info({ resetCount }, "context_indexes_reset");
    }
    return { resetCount };
  }

  getLastDebugReport(): ContextRetrievalDebugReport | null {
    return this.lastDebugReport;
  }

  async rebuildUserIndex(input: {
    userId: string;
    forceReembed?: boolean;
    embeddingBatchSize?: number;
    abortSignal?: AbortSignal;
  }): Promise<{
    userId: string;
    embeddingProfileId?: string;
    embeddedCount: number;
    indexedCount: number;
    skippedCount: number;
    error?: string;
  }> {
    const reembedReport = await this.reembedUserContext({
      userId: input.userId,
      ...(input.forceReembed !== undefined ? { force: input.forceReembed } : {}),
      ...(input.embeddingBatchSize !== undefined ? { batchSize: input.embeddingBatchSize } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    if (reembedReport.error) {
      return {
        userId: input.userId,
        embeddedCount: reembedReport.embeddedCount,
        indexedCount: 0,
        skippedCount: reembedReport.skippedCount,
        error: reembedReport.error
      };
    }
    const documents = this.contextStore.listUserSearchDocuments(input.userId);
    const storedEmbeddings = reembedReport.embeddingProfileId
      ? this.contextStore.getItemEmbeddings(
          documents.map((item) => item.itemId),
          reembedReport.embeddingProfileId
        )
      : new Map<string, number[]>();
    const indexedDocuments = documents
      .map((document) => {
        const embedding = storedEmbeddings.get(document.itemId);
        return embedding ? { ...document, embedding } : null;
      })
      .filter((item): item is ContextSearchDocument & { embedding: number[] } => item != null);
    if (indexedDocuments.length === 0) {
      const existing = this.userIndexes.get(input.userId);
      existing?.reset();
      this.userIndexes.delete(input.userId);
      return {
        userId: input.userId,
        ...(reembedReport.embeddingProfileId ? { embeddingProfileId: reembedReport.embeddingProfileId } : {}),
        embeddedCount: reembedReport.embeddedCount,
        indexedCount: 0,
        skippedCount: reembedReport.skippedCount
      };
    }
    const index = this.getUserIndex(input.userId);
    await index.rebuild({
      signature: buildIndexSignature(reembedReport.embeddingProfileId!, indexedDocuments),
      documents: indexedDocuments
    });
    this.logger.info({
      userId: input.userId,
      embeddingProfileId: reembedReport.embeddingProfileId,
      embeddedCount: reembedReport.embeddedCount,
      indexedCount: indexedDocuments.length,
      skippedCount: reembedReport.skippedCount
    }, "context_user_index_rebuilt");
    return {
      userId: input.userId,
      ...(reembedReport.embeddingProfileId ? { embeddingProfileId: reembedReport.embeddingProfileId } : {}),
      embeddedCount: reembedReport.embeddedCount,
      indexedCount: indexedDocuments.length,
      skippedCount: reembedReport.skippedCount
    };
  }

  async rebuildUserIndexes(input: {
    userId?: string;
    forceReembed?: boolean;
    embeddingBatchSize?: number;
    abortSignal?: AbortSignal;
  } = {}): Promise<{
    userCount: number;
    embeddedCount: number;
    indexedCount: number;
    skippedCount: number;
    errors: Array<{ userId: string; error: string }>;
  }> {
    const userIds = input.userId
      ? [input.userId]
      : this.contextStore.listUserIdsWithSearchDocuments();
    let embeddedCount = 0;
    let indexedCount = 0;
    let skippedCount = 0;
    const errors: Array<{ userId: string; error: string }> = [];
    for (const userId of userIds) {
      const result = await this.rebuildUserIndex({
        userId,
        ...(input.forceReembed !== undefined ? { forceReembed: input.forceReembed } : {}),
        ...(input.embeddingBatchSize !== undefined ? { embeddingBatchSize: input.embeddingBatchSize } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });
      embeddedCount += result.embeddedCount;
      indexedCount += result.indexedCount;
      skippedCount += result.skippedCount;
      if (result.error) {
        errors.push({ userId, error: result.error });
      }
    }
    return {
      userCount: userIds.length,
      embeddedCount,
      indexedCount,
      skippedCount,
      errors
    };
  }

  async reembedUserContext(input: {
    userId: string;
    force?: boolean;
    batchSize?: number;
    abortSignal?: AbortSignal;
  }): Promise<{
    userId: string;
    embeddingProfileId?: string;
    embeddedCount: number;
    skippedCount: number;
    error?: string;
  }> {
    if (!this.embeddingService.isConfigured()) {
      return {
        userId: input.userId,
        embeddedCount: 0,
        skippedCount: 0,
        error: "embedding is not configured"
      };
    }
    try {
      const documents = this.contextStore.listUserSearchDocuments(input.userId);
      if (documents.length === 0) {
        return {
          userId: input.userId,
          embeddedCount: 0,
          skippedCount: 0
        };
      }
      const profileProbe = await this.embeddingService.embedTexts(["上下文索引维护"], {
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });
      const profile = profileProbe.profile;
      this.contextStore.upsertEmbeddingProfile(profile);
      const storedEmbeddings = this.contextStore.getItemEmbeddings(
        documents.map((item) => item.itemId),
        profile.profileId
      );
      const targetDocuments = (input.force
        ? documents
        : documents.filter((item) => !storedEmbeddings.has(item.itemId)));
      const batchSize = Math.max(0, input.batchSize ?? 32);
      const batch = targetDocuments.slice(0, batchSize);
      if (batch.length === 0) {
        return {
          userId: input.userId,
          embeddingProfileId: profile.profileId,
          embeddedCount: 0,
          skippedCount: targetDocuments.length
        };
      }
      const embeddedDocuments = await this.embeddingService.embedTexts(
        batch.map((item) => item.text),
        {
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        }
      );
      if (embeddedDocuments.profile.profileId !== profile.profileId) {
        throw new Error("Embedding profile changed during context re-embed");
      }
      let embeddedCount = 0;
      for (let index = 0; index < batch.length; index += 1) {
        const document = batch[index];
        const vector = embeddedDocuments.vectors[index];
        if (!document || !vector) {
          continue;
        }
        this.contextStore.upsertItemEmbedding({
          itemId: document.itemId,
          embeddingProfileId: profile.profileId,
          vector
        });
        embeddedCount += 1;
      }
      return {
        userId: input.userId,
        embeddingProfileId: profile.profileId,
        embeddedCount,
        skippedCount: Math.max(0, targetDocuments.length - batch.length)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ userId: input.userId, error: message }, "context_reembed_failed_open");
      return {
        userId: input.userId,
        embeddedCount: 0,
        skippedCount: 0,
        error: message
      };
    }
  }
}

function buildIndexSignature(
  embeddingProfileId: string,
  documents: Array<ContextSearchDocument & { embedding: number[] }>
): string {
  return [
    embeddingProfileId,
    ...documents.map((item) => `${item.itemId}:${item.updatedAt}:${hashEmbeddingVector(item.embedding)}`)
  ].join("|");
}

function toAlwaysRetrievedItem(document: ContextSearchDocument): ContextRetrievedItem {
  return {
    itemId: document.itemId,
    scope: document.scope,
    sourceType: document.sourceType,
    ...(document.userId ? { userId: document.userId } : {}),
    ...(document.sessionId ? { sessionId: document.sessionId } : {}),
    ...(document.title ? { title: document.title } : {}),
    text: document.text,
    score: 1,
    updatedAt: document.updatedAt
  };
}

function hashEmbeddingVector(vector: number[]): string {
  const hash = createHash("sha256");
  for (const value of vector) {
    hash.update(`${value};`);
  }
  return `${vector.length}:${hash.digest("base64url")}`;
}

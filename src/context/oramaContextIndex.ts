import { create, insertMultiple, search } from "@orama/orama";
import type { ContextRetrievedItem, ContextSearchDocument } from "./contextTypes.ts";

interface IndexedContextDocument extends ContextSearchDocument {
  id: string;
  item_id: string;
  scope_value: string;
  layer_value: string;
  subject_kind: string;
  subject_id: string;
  source_type: string;
  retrieval_policy: string;
  user_id: string;
  session_id: string;
  slot_key: string;
  kind_value: string;
  importance_value: number;
  updated_at: number;
  embedding: number[];
}

export class OramaContextIndex {
  private constructor(
    private readonly db: unknown,
    private readonly vectorSize: number,
    readonly size: number
  ) {}

  static async build(documents: Array<ContextSearchDocument & { embedding: number[] }>): Promise<OramaContextIndex> {
    const firstVectorSize = documents[0]?.embedding.length ?? 0;
    if (documents.length === 0 || firstVectorSize <= 0) {
      return new OramaContextIndex(null, 0, 0);
    }
    const db = await create({
      schema: {
        id: "string",
        item_id: "enum",
        scope_value: "string",
        layer_value: "string",
        subject_kind: "string",
        subject_id: "string",
        source_type: "string",
        retrieval_policy: "string",
        user_id: "string",
        session_id: "string",
        title: "string",
        slot_key: "string",
        kind_value: "string",
        importance_value: "number",
        text: "string",
        updated_at: "number",
        embedding: `vector[${firstVectorSize}]`
      }
    });
    await insertMultiple(db, documents.map(toIndexedDocument));
    return new OramaContextIndex(db, firstVectorSize, documents.length);
  }

  async search(input: {
    userId: string;
    excludeItemIds?: readonly string[];
    queryText: string;
    queryVector: number[];
    limit: number;
    candidateMultiplier: number;
    minScore: number;
  }): Promise<ContextRetrievedItem[]> {
    if (input.limit <= 0 || !this.db || this.vectorSize !== input.queryVector.length) {
      return [];
    }
    const response = await search(this.db as never, {
      mode: "hybrid",
      term: input.queryText,
      vector: {
        value: input.queryVector,
        property: "embedding"
      },
      properties: ["title", "text"],
      where: {
        user_id: input.userId,
        ...(input.excludeItemIds?.length ? { item_id: { nin: input.excludeItemIds } } : {})
      },
      limit: Math.max(input.limit * input.candidateMultiplier, input.limit),
      similarity: 0,
      threshold: input.minScore,
      hybridWeights: {
        vector: 0.72,
        text: 0.28
      },
      includeVectors: false
    } as never) as {
      hits: Array<{
        score: number;
        document: IndexedContextDocument;
      }>;
    };

    return response.hits
      .map((hit) => ({
        itemId: hit.document.itemId,
        scope: hit.document.scope,
        layer: hit.document.layer,
        subjectKind: hit.document.subjectKind,
        ...(hit.document.subjectId ? { subjectId: hit.document.subjectId } : {}),
        sourceType: hit.document.sourceType,
        ...(hit.document.userId ? { userId: hit.document.userId } : {}),
        ...(hit.document.sessionId ? { sessionId: hit.document.sessionId } : {}),
        ...(hit.document.title ? { title: hit.document.title } : {}),
        ...(hit.document.slotKey ? { slotKey: hit.document.slotKey } : {}),
        ...(hit.document.kind ? { kind: hit.document.kind } : {}),
        ...(hit.document.importance !== undefined ? { importance: hit.document.importance } : {}),
        text: hit.document.text,
        score: hit.score,
        updatedAt: hit.document.updatedAt
      }))
      .filter((item) => item.score >= input.minScore);
  }

}

function toIndexedDocument(document: ContextSearchDocument & { embedding: number[] }): IndexedContextDocument {
  return {
    ...document,
    id: document.itemId,
    item_id: document.itemId,
    scope_value: document.scope,
    layer_value: document.layer,
    subject_kind: document.subjectKind,
    subject_id: document.subjectId ?? "",
    source_type: document.sourceType,
    retrieval_policy: document.retrievalPolicy,
    user_id: document.userId ?? "",
    session_id: document.sessionId ?? "",
    title: document.title ?? "",
    slot_key: document.slotKey ?? "",
    kind_value: document.kind ?? "",
    importance_value: document.importance ?? 0,
    updated_at: document.updatedAt
  };
}

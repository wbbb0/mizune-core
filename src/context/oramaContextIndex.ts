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
  private db: unknown = null;
  private vectorSize: number | null = null;
  private signature: string | null = null;

  async rebuild(input: {
    signature: string;
    documents: Array<ContextSearchDocument & { embedding: number[] }>;
  }): Promise<void> {
    const firstVectorSize = input.documents[0]?.embedding.length ?? 0;
    if (input.documents.length === 0 || firstVectorSize <= 0) {
      this.reset();
      this.signature = input.signature;
      return;
    }
    if (this.signature === input.signature && this.db) {
      return;
    }

    const db = await create({
      schema: {
        id: "string",
        item_id: "string",
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
    await insertMultiple(db, input.documents.map(toIndexedDocument));
    this.db = db;
    this.vectorSize = firstVectorSize;
    this.signature = input.signature;
  }

  async search(input: {
    userId: string;
    queryText: string;
    queryVector: number[];
    limit: number;
    candidateMultiplier: number;
    minScore: number;
  }): Promise<ContextRetrievedItem[]> {
    if (!this.db || this.vectorSize !== input.queryVector.length) {
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
        user_id: input.userId
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

  reset(): void {
    this.db = null;
    this.vectorSize = null;
    this.signature = null;
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

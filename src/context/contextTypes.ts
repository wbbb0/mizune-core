export type ContextScope = "session" | "user" | "global" | "toolset" | "mode";
export type ContextSourceType = "chunk" | "summary" | "fact" | "rule";
export type ContextRetrievalPolicy = "always" | "search" | "never";
export type ContextItemStatus = "active" | "archived" | "deleted" | "superseded";
export type ContextSensitivity = "normal" | "private" | "secret";

export interface ContextItem {
  itemId: string;
  scope: ContextScope;
  sourceType: ContextSourceType;
  retrievalPolicy: ContextRetrievalPolicy;
  status: ContextItemStatus;
  userId?: string;
  sessionId?: string;
  toolsetId?: string;
  modeId?: string;
  title?: string;
  text: string;
  kind?: string;
  source?: string;
  confidence?: number;
  importance?: number;
  pinned?: boolean;
  sensitivity: ContextSensitivity;
  createdAt: number;
  updatedAt: number;
  validFrom?: number;
  validTo?: number;
  supersededBy?: string;
  lastConfirmedAt?: number;
  retrievedCount: number;
  lastRetrievedAt?: number;
}

export interface ContextRawMessage {
  messageId: string;
  userId: string;
  sessionId: string;
  chatType: "private" | "group";
  role: "user" | "assistant" | "system";
  speakerId?: string;
  timestampMs: number;
  text: string;
  segments?: unknown;
  attachmentRefs?: unknown;
  sensitivity: ContextSensitivity;
  ingestedAt: number;
}

export interface ContextSearchDocument {
  itemId: string;
  scope: ContextScope;
  sourceType: ContextSourceType;
  retrievalPolicy: ContextRetrievalPolicy;
  userId?: string;
  sessionId?: string;
  title?: string;
  text: string;
  updatedAt: number;
  lastRetrievedAt?: number;
}

export interface ContextEmbeddingProfile {
  profileId: string;
  instanceName: string;
  provider: string;
  model: string;
  dimension: number;
  distance: "cosine";
  textPreprocessVersion: string;
  chunkerVersion: string;
}

export interface ContextRetrievedItem {
  itemId: string;
  scope: ContextScope;
  sourceType: ContextSourceType;
  userId?: string;
  sessionId?: string;
  title?: string;
  text: string;
  score: number;
  updatedAt: number;
}

export interface ContextRetrievalDebugReport {
  userId: string;
  queryText: string;
  embeddingProfileId?: string;
  candidateCount: number;
  indexedCount: number;
  selectedCount: number;
  droppedCount: number;
  error?: string;
  createdAt: number;
}

export interface ContextManagementItem {
  itemId: string;
  scope: ContextScope;
  sourceType: ContextSourceType;
  retrievalPolicy: ContextRetrievalPolicy;
  status: ContextItemStatus;
  userId?: string;
  sessionId?: string;
  toolsetId?: string;
  modeId?: string;
  title?: string;
  text: string;
  kind?: string;
  source?: string;
  importance?: number;
  pinned: boolean;
  sensitivity: ContextSensitivity;
  createdAt: number;
  updatedAt: number;
  validTo?: number;
  supersededBy?: string;
  lastRetrievedAt?: number;
}

export interface ContextItemPatch {
  itemId: string;
  title?: string | null;
  text?: string;
  retrievalPolicy?: ContextRetrievalPolicy;
  status?: ContextItemStatus;
  sensitivity?: ContextSensitivity;
  importance?: number | null;
  pinned?: boolean;
  validTo?: number | null;
  supersededBy?: string | null;
}

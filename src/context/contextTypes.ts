export type ContextScope = "session" | "user" | "global" | "toolset" | "mode";
export type ContextSourceType = "episode" | "chunk" | "summary" | "fact" | "rule";
export type ContextRetrievalPolicy = "always" | "search" | "never";
export type ContextItemStatus = "active" | "archived" | "deleted" | "superseded" | "pending";
export type ContextSensitivity = "normal" | "private" | "secret";
export type ContextMemoryLayer = "profile_slot" | "core_fact" | "searchable_fact" | "episode" | "proposal";
export type ContextSubjectKind = "session" | "user" | "global" | "toolset" | "mode";

export interface ContextItem {
  itemId: string;
  scope: ContextScope;
  layer?: ContextMemoryLayer;
  subjectKind?: ContextSubjectKind;
  subjectId?: string;
  sourceType: ContextSourceType;
  retrievalPolicy: ContextRetrievalPolicy;
  status: ContextItemStatus;
  userId?: string;
  sessionId?: string;
  toolsetId?: string;
  modeId?: string;
  title?: string;
  slotKey?: string;
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
  promptedCount?: number;
  lastPromptedAt?: number;
  lastAuditedAt?: number;
  auditState?: string;
}

export interface ContextMemoryFactEntry {
  id: string;
  title: string;
  content: string;
  kind: "preference" | "fact" | "boundary" | "habit" | "relationship" | "other";
  source: "user_explicit" | "owner_explicit" | "inferred";
  createdAt: number;
  updatedAt: number;
  importance?: number;
  lastUsedAt?: number;
  slotKey?: string;
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
  layer: ContextMemoryLayer;
  subjectKind: ContextSubjectKind;
  subjectId?: string;
  sourceType: ContextSourceType;
  retrievalPolicy: ContextRetrievalPolicy;
  userId?: string;
  sessionId?: string;
  title?: string;
  slotKey?: string;
  kind?: string;
  importance?: number;
  text: string;
  embeddingTextHash: string;
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
  layer: ContextMemoryLayer;
  subjectKind: ContextSubjectKind;
  subjectId?: string;
  sourceType: ContextSourceType;
  userId?: string;
  sessionId?: string;
  title?: string;
  slotKey?: string;
  kind?: string;
  importance?: number;
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

export type ContextPromptMemoryEntrySource = "semantic_retrieval";
export type ContextPromptMemoryRetrievalSkipReason =
  | "scenario_host_mode"
  | "assistant_mode"
  | "missing_user"
  | "service_unavailable";

export interface ContextPromptMemoryItem {
  itemId: string;
  entrySource: ContextPromptMemoryEntrySource;
  scope: ContextScope;
  layer: ContextMemoryLayer;
  subjectKind: ContextSubjectKind;
  subjectId?: string;
  sourceType: ContextSourceType;
  title?: string;
  slotKey?: string;
  kind?: ContextMemoryFactEntry["kind"];
  memorySource?: ContextMemoryFactEntry["source"];
  text: string;
  score?: number;
  importance?: number;
  updatedAt: number;
}

export interface ContextPromptMemoryReport {
  sessionId: string;
  modeId?: string;
  userId?: string;
  queryText: string;
  currentUserFactCount: number;
  availableUserFactCount: number;
  userFactLimit: number;
  userFactTruncated: boolean;
  currentSessionFactCount: number;
  availableSessionFactCount: number;
  sessionFactLimit: number;
  sessionFactTruncated: boolean;
  retrievedUserContextCount: number;
  selectedCount: number;
  semanticRetrieval: {
    attempted: boolean;
    skippedReason?: ContextPromptMemoryRetrievalSkipReason;
    debugReport?: ContextRetrievalDebugReport;
  };
  retrievedUserContext: ContextPromptMemoryItem[];
  createdAt: number;
}

export interface ContextManagementItem {
  itemId: string;
  scope: ContextScope;
  layer: ContextMemoryLayer;
  subjectKind: ContextSubjectKind;
  subjectId?: string;
  sourceType: ContextSourceType;
  retrievalPolicy: ContextRetrievalPolicy;
  status: ContextItemStatus;
  userId?: string;
  sessionId?: string;
  toolsetId?: string;
  modeId?: string;
  title?: string;
  slotKey?: string;
  text: string;
  kind?: string;
  source?: string;
  confidence?: number;
  importance?: number;
  pinned: boolean;
  sensitivity: ContextSensitivity;
  createdAt: number;
  updatedAt: number;
  validFrom?: number;
  validTo?: number;
  supersededBy?: string;
  lastConfirmedAt?: number;
  retrievedCount?: number;
  lastRetrievedAt?: number;
  promptedCount?: number;
  lastPromptedAt?: number;
  lastAuditedAt?: number;
  auditState?: string;
}

export interface ContextMemoryProposalInput {
  scope: ContextScope;
  userId?: string;
  sessionId?: string;
  toolsetId?: string;
  modeId?: string;
  title: string;
  content: string;
  kind?: string;
  source?: string;
  confidence?: number;
  importance?: number;
  reason: string;
  sourceRefs?: Array<{
    sourceKind: string;
    sourceId: string;
  }>;
  createdAt?: number;
}

export interface ContextItemPatch {
  itemId: string;
  title?: string | null;
  slotKey?: string | null;
  text?: string;
  retrievalPolicy?: ContextRetrievalPolicy;
  status?: ContextItemStatus;
  sensitivity?: ContextSensitivity;
  importance?: number | null;
  pinned?: boolean;
  validTo?: number | null;
  supersededBy?: string | null;
}

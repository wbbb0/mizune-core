import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { EnrichedIncomingMessage } from "#app/messaging/messageHandlerTypes.ts";

export type ModerationSubjectKind =
  | "text"
  | "image"
  | "emoji"
  | "audio_transcript"
  | "file"
  | "local_media";

export type ModerationDecision = "allow" | "review" | "block" | "error";

export interface ModerationLabel {
  label: string;
  category?: string | undefined;
  riskLevel?: "none" | "low" | "medium" | "high" | undefined;
  confidence?: number | undefined;
  providerReason?: string | undefined;
}

export interface ModerationResult {
  decision: ModerationDecision;
  reason: string;
  labels: ModerationLabel[];
  providerId: string;
  providerType: string;
  requestId?: string | undefined;
  rawDecision?: string | undefined;
  checkedAtMs: number;
}

export interface ModerationContext {
  sessionId?: string | undefined;
  delivery?: "onebot" | "web" | undefined;
  userId?: string | undefined;
  groupId?: string | undefined;
  source?: string | undefined;
}

export interface ModerateTextInput {
  subjectKind: "text" | "audio_transcript";
  text: string;
  languageHint?: string | undefined;
  context: ModerationContext;
  abortSignal?: AbortSignal | undefined;
}

export interface ModerateMediaInput {
  subjectKind: "image" | "emoji" | "file" | "local_media";
  fileId?: string | undefined;
  sourceName?: string | undefined;
  mimeType?: string | undefined;
  absolutePath?: string | undefined;
  context: ModerationContext;
  abortSignal?: AbortSignal | undefined;
}

export interface ContentModerationProvider {
  id: string;
  type: string;
  capabilities: Set<ModerationSubjectKind>;
  moderateText?: (input: ModerateTextInput) => Promise<ModerationResult>;
  moderateMedia?: (input: ModerateMediaInput) => Promise<ModerationResult>;
}

export interface ContentSafetyEvent {
  subjectKind: ModerationSubjectKind;
  decision: ModerationDecision;
  marker: string | null;
  auditKey: string | null;
  fileId?: string | undefined;
  audioId?: string | undefined;
  contentHash?: string | undefined;
  reason: string;
}

export interface ContentSafetyAuditRecord {
  key: string;
  subjectKind: ModerationSubjectKind;
  decision: ModerationDecision;
  marker: string;
  result: ModerationResult;
  originalText?: string | undefined;
  fileId?: string | undefined;
  audioId?: string | undefined;
  contentHash?: string | undefined;
  sourceName?: string | undefined;
  sessionId?: string | undefined;
  checkedAtMs: number;
  expiresAtMs?: number | undefined;
}

export interface ContentSafetyProjection {
  projectIncomingMessage: (input: EnrichedIncomingMessage) => Promise<EnrichedIncomingMessage>;
  projectTranscriptItemForLlm: (input: InternalTranscriptItem) => Promise<InternalTranscriptItem>;
  guardChatFileForLlm: (fileId: string) => Promise<"allow" | { blocked: true; marker: string; reason: string }>;
}


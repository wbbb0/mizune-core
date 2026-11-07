import type { ModelSelectionScores } from "./modelSelectionScores.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { SpecialRole } from "#identity/specialRole.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type { ToolsetView } from "#llm/tools/toolsets.ts";
import type { OneBotMessageFileSummary, OneBotSpecialSegmentSummary } from "#services/onebot/types.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import type { TaskPlannerIntent, TurnPlannerTaskContext } from "#conversation/taskTracker/taskTrackerPlannerContext.ts";
import type { TurnPlannerRequirements } from "../turnPlannerPolicy.ts";
import type { analyzeTurnPlannerBatch } from "../turnPlannerBatchAnalysis.ts";
import type { LlmUsage } from "#llm/llmClient.ts";

export const turnPlannerRequiredCapabilities = [
  "external_info_lookup", "web_navigation", "filesystem_access", "shell_execution", "memory_write",
  "scheduler_management", "time_lookup", "social_admin", "conversation_navigation", "chat_delegation", "image_generation"
] as const;
export type TurnPlannerRequiredCapability = typeof turnPlannerRequiredCapabilities[number];

export const turnPlannerContextDependencies = [
  "structured_message_context", "prior_web_context", "prior_shell_context", "prior_file_context", "prior_chat_context"
] as const;
export type TurnPlannerContextDependency = typeof turnPlannerContextDependencies[number];

export type TurnPlannerFollowupMode = "none" | "elliptical" | "explicit_reference";

export interface TurnPlannerInput {
  requirements: TurnPlannerRequirements;
  availableSkills?: Array<{ id: string; name: string; description: string }>;
  sessionId: string;
  chatType: "private" | "group";
  relationship: Relationship;
  currentUserSpecialRole?: SpecialRole | null;
  modeId?: string | null;
  modeSignalLine?: string | null;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>;
  abortSignal?: AbortSignal;
  availableToolsets?: ToolsetView[];
  operationSummary?: string[];
  taskSummary?: string | null | undefined;
  taskContext?: TurnPlannerTaskContext | null | undefined;
  batchMessages: Array<{
    senderName: string;
    text: string;
    contentParts?: MessageContentPart[];
    images: string[];
    audioSources: string[];
    audioIds?: string[];
    imageIds: string[];
    emojiIds: string[];
    attachments?: ChatAttachment[];
    messageFiles?: OneBotMessageFileSummary[];
    specialSegments?: OneBotSpecialSegmentSummary[];
    forwardIds: string[];
    replyMessageId: string | null;
    mentionUserIds: string[];
    mentionedAll: boolean;
    mentionedSelf: boolean;
    timestampMs?: number | null;
  }>;
}

export interface TurnPlannerResult {
  replyDecision: "reply" | "wait" | "no_reply";
  modelTier?: "small" | "large";
  modelSelectionStatus?: "decided" | "undetermined" | "not_requested";
  modelSelectionScores?: ModelSelectionScores;
  taskBasis?: string;
  undeterminedQuestions?: string[];
  topicDecision: "continue_topic" | "new_topic";
  reason: string;
  waitReason?: "unfinished_message" | "none";
  requiredCapabilities: TurnPlannerRequiredCapability[];
  contextDependencies: TurnPlannerContextDependency[];
  recentDomainReuse: string[];
  followupMode: TurnPlannerFollowupMode;
  toolsetIds: string[];
  skillIds?: string[];
  topicDecisionEvaluated?: boolean;
  taskIntent?: TaskPlannerIntent | undefined;
  reasoningContent?: string;
  metrics?: TurnPlannerMetrics;
}

export type TurnPlannerBackend = "chat" | "decision";

export interface TurnPlannerMetrics {
  backend?: TurnPlannerBackend;
  modelRef?: string;
  fallbackReason?: "decision_failed" | "question_limit";
  durationMs: number;
  mediaPreparationMs: number;
  generationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  mediaCaptionCount: number;
  emojiInputCount: number;
  imageInputCount?: number;
}

export interface PreparedTurnPlannerInput extends TurnPlannerInput {
  availableToolsets: ToolsetView[];
  batchAnalysis: ReturnType<typeof analyzeTurnPlannerBatch>;
  visualInputs: Array<{ imageId: string; kind: "image" | "emoji"; inputUrl: string; animated: boolean; durationMs: number | null; sampledFrameCount: number | null }>;
  mediaCaptions: Array<{ imageId: string; kind: "image" | "emoji"; caption: string }>;
}

export interface TurnPlannerEvaluation {
  plan: TurnPlannerResult;
  usage?: LlmUsage;
}

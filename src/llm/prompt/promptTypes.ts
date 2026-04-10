import type { MemoryEntry } from "#memory/memoryEntry.ts";
import type { Persona } from "#persona/personaSchema.ts";
import type { EditablePersonaFieldName } from "#persona/personaSchema.ts";
import type { SpecialRole } from "#identity/specialRole.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { SessionDebugMarker } from "#conversation/session/sessionManager.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type { ToolsetView } from "#llm/tools/toolsets.ts";
import type { LlmMessage } from "../llmClient.ts";

export type PromptInteractionMode = "normal" | "debug";

export interface PromptNpcProfile {
  userId: string;
  displayName: string;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  profileSummary?: string;
  sharedContext?: string;
}

export interface PromptParticipantProfile {
  userId: string;
  displayName: string;
  relationshipLabel: string;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  profileSummary?: string;
  sharedContext?: string;
}

export interface PromptUserProfile {
  userId?: string;
  senderName?: string;
  nickname?: string;
  relationship?: Relationship;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  profileSummary?: string;
  sharedContext?: string;
  memories?: MemoryEntry[];
  specialRole?: SpecialRole;
}

export interface PromptHistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestampMs?: number | null;
}

export interface PromptToolEvent {
  toolName: string;
  argsSummary: string;
  outcome: "success" | "error";
  resultSummary: string;
  timestampMs?: number | null;
}

export interface PromptLiveResource {
  resourceId: string;
  kind: "browser_page" | "shell_session";
  status: "active" | "expired" | "closed" | "unrecoverable";
  title?: string | null;
  description?: string | null;
  summary: string;
}

export interface PromptOperationNote {
  id: string;
  title: string;
  content: string;
  toolsetIds: string[];
}

export interface PromptEmojiVisual {
  imageId: string;
  inputUrl: string;
  animated: boolean;
  durationMs: number | null;
  sampledFrameCount: number | null;
}

export interface PromptImageVisual {
  imageId: string;
  inputUrl: string;
}

export interface PromptImageCaption {
  imageId: string;
  caption: string;
}

export interface PromptAudioInput {
  source: string;
  mimeType: string;
  format: string;
  data: string;
}

export interface PromptAudioTranscription {
  audioId: string;
  status: "ready" | "failed";
  text?: string;
  error?: string | null;
}

export interface PromptBatchMessage {
  userId: string;
  senderName: string;
  text: string;
  images: string[];
  audioSources: string[];
  audioIds: string[];
  audioInputs?: PromptAudioInput[];
  audioTranscriptions?: PromptAudioTranscription[];
  emojiSources: string[];
  imageIds: string[];
  imageCaptions?: PromptImageCaption[];
  imageVisuals?: PromptImageVisual[];
  emojiIds: string[];
  emojiCaptions?: PromptImageCaption[];
  emojiVisuals?: PromptEmojiVisual[];
  attachments?: ChatAttachment[];
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  mentionedSelf: boolean;
  timestampMs?: number | null;
}

export interface PromptInput {
  sessionId: string;
  interactionMode?: PromptInteractionMode;
  visibleToolNames?: string[];
  activeToolsets?: ToolsetView[];
  lateSystemMessages?: string[] | undefined;
  replayMessages?: LlmMessage[] | undefined;
  includeBatchMediaCaptions?: boolean | undefined;
  persona: Persona;
  relationship: Relationship;
  npcProfiles: PromptNpcProfile[];
  participantProfiles: PromptParticipantProfile[];
  userProfile: PromptUserProfile;
  globalMemories?: MemoryEntry[];
  historySummary?: string | null | undefined;
  recentMessages: PromptHistoryMessage[];
  recentToolEvents?: PromptToolEvent[] | undefined;
  debugMarkers?: SessionDebugMarker[] | undefined;
  liveResources?: PromptLiveResource[] | undefined;
  operationNotes?: PromptOperationNote[] | undefined;
  batchMessages: PromptBatchMessage[];
}

export interface InternalSessionTriggerPromptInput {
  sessionId: string;
  interactionMode?: PromptInteractionMode;
  visibleToolNames?: string[];
  activeToolsets?: ToolsetView[];
  lateSystemMessages?: string[] | undefined;
  replayMessages?: PromptInput["replayMessages"];
  trigger:
    | {
        kind: "scheduled_instruction";
        jobName: string;
        taskInstruction: string;
      }
    | {
        kind: "comfy_task_completed";
        jobName: string;
        taskInstruction: string;
        taskId: string;
        templateId: string;
        positivePrompt: string;
        aspectRatio: string;
        resolvedWidth: number;
        resolvedHeight: number;
        workspaceFileIds: string[];
        chatFilePaths: string[];
        comfyPromptId: string;
        autoIterationIndex: number;
        maxAutoIterations: number;
      }
    | {
        kind: "comfy_task_failed";
        jobName: string;
        taskInstruction: string;
        taskId: string;
        templateId: string;
        positivePrompt: string;
        aspectRatio: string;
        resolvedWidth: number;
        resolvedHeight: number;
        comfyPromptId: string;
        lastError: string;
        autoIterationIndex: number;
        maxAutoIterations: number;
      };
  persona: Persona;
  relationship: Relationship;
  npcProfiles: PromptInput["npcProfiles"];
  participantProfiles: PromptInput["participantProfiles"];
  userProfile: PromptInput["userProfile"];
  globalMemories?: PromptInput["globalMemories"];
  historySummary?: string | null | undefined;
  recentMessages: PromptInput["recentMessages"];
  recentToolEvents?: PromptInput["recentToolEvents"];
  debugMarkers?: PromptInput["debugMarkers"];
  liveResources?: PromptInput["liveResources"];
  operationNotes?: PromptInput["operationNotes"];
  targetContext:
    | {
        chatType: "private";
        userId: string;
        senderName: string;
      }
    | {
        chatType: "group";
        groupId: string;
      };
}

export type ScheduledTaskPromptInput = InternalSessionTriggerPromptInput;

export interface SetupPromptInput {
  sessionId: string;
  interactionMode?: PromptInteractionMode;
  includeBatchMediaCaptions?: boolean | undefined;
  lateSystemMessages?: string[] | undefined;
  replayMessages?: PromptInput["replayMessages"];
  persona: Persona;
  missingFields: EditablePersonaFieldName[];
  recentMessages: PromptInput["recentMessages"];
  recentToolEvents?: PromptInput["recentToolEvents"];
  debugMarkers?: PromptInput["debugMarkers"];
  liveResources?: PromptInput["liveResources"];
  batchMessages: PromptInput["batchMessages"];
}

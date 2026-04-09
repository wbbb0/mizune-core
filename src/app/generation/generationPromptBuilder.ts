import {
  annotateHistoryMessagesWithCaptions,
  buildPromptImageCaptions,
  collectReferencedImageIds
} from "#images/imagePromptContext.ts";
import { getDefaultMainModelRefs, getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { prepareAudioInputsForModel } from "#messages/audioSources.ts";
import { buildPrompt, buildScheduledTaskPrompt, buildSetupPrompt } from "#llm/prompt/promptBuilder.ts";
import type { PromptInteractionMode, PromptLiveResource } from "#llm/prompt/promptTypes.ts";
import type { PromptAudioTranscription } from "#llm/prompt/promptTypes.ts";
import type {
  InternalTranscriptItem,
  SessionDebugMarker,
  SessionUsageSnapshot
} from "#conversation/session/sessionManager.ts";
import type { PersonaStore } from "#persona/personaStore.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { LlmMessage } from "#llm/llmClient.ts";
import type { PromptDebugSnapshot } from "#llm/tools/core/shared.ts";
import type { GenerationPromptBuilderDeps } from "./generationRunnerDeps.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";

type PersonaState = Awaited<ReturnType<PersonaStore["get"]>>;
type StoredUser = Awaited<ReturnType<UserStore["getByUserId"]>>;
const LIVE_RESOURCE_TOOL_NAMES = new Set([
  "list_live_resources",
  "open_page",
  "inspect_page",
  "interact_with_page",
  "close_page",
  "shell_run",
  "shell_interact",
  "shell_read",
  "shell_signal"
]);

export interface GenerationPromptHistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestampMs?: number | null;
}

export interface GenerationPromptToolEvent {
  toolName: string;
  argsSummary: string;
  outcome: "success" | "error";
  resultSummary: string;
  timestampMs?: number | null;
}

export interface GenerationPromptParticipantProfile {
  userId: string;
  displayName: string;
  relationshipLabel: string;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  profileSummary?: string;
  sharedContext?: string;
}

export interface GenerationPromptBatchMessage {
  userId: string;
  senderName: string;
  text: string;
  images: string[];
  audioSources: string[];
  audioIds: string[];
  emojiSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  isAtMentioned: boolean;
  receivedAt: number;
}

export type ScheduledPromptTargetContext = Parameters<typeof buildScheduledTaskPrompt>[0]["targetContext"];

export interface GenerationPromptBuildResult {
  promptMessages: LlmMessage[];
  debugSnapshot: PromptDebugSnapshot;
}

export interface GenerationPromptBuilder {
  buildChatPromptMessages: (input: {
    sessionId: string;
    interactionMode: PromptInteractionMode;
    mainModelRef: string[];
    visibleToolNames: string[];
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    persona: PersonaState;
    relationship: Relationship;
    participantProfiles: GenerationPromptParticipantProfile[];
    currentUser: StoredUser;
    historySummary: string | null;
    historyForPrompt: GenerationPromptHistoryMessage[];
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
  }) => Promise<GenerationPromptBuildResult>;
  buildScheduledPromptMessages: (input: {
    sessionId: string;
    interactionMode: PromptInteractionMode;
    visibleToolNames: string[];
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    trigger: Parameters<typeof buildScheduledTaskPrompt>[0]["trigger"];
    persona: PersonaState;
    relationship: Relationship;
    participantProfiles: GenerationPromptParticipantProfile[];
    currentUser: StoredUser;
    historySummary: string | null;
    historyForPrompt: GenerationPromptHistoryMessage[];
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    targetContext: ScheduledPromptTargetContext;
    abortSignal?: AbortSignal;
  }) => Promise<GenerationPromptBuildResult>;
  buildSetupPromptMessages: (input: {
    sessionId: string;
    interactionMode: PromptInteractionMode;
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    persona: PersonaState;
    historyForPrompt: GenerationPromptHistoryMessage[];
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    currentUser: StoredUser;
    participantProfiles: GenerationPromptParticipantProfile[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
  }) => Promise<GenerationPromptBuildResult>;
}

// Converts relevant NPC records into prompt-friendly profile payloads.
function buildNpcPromptProfiles(deps: GenerationPromptBuilderDeps, relevantUserIds: Iterable<string>) {
  const relevant = new Set(Array.from(relevantUserIds));
  return deps.npcDirectory.listProfiles().filter((item) => relevant.has(item.userId)).map((item) => ({
    userId: item.userId,
    displayName: item.nickname ?? item.userId,
    ...(item.preferredAddress ? { preferredAddress: item.preferredAddress } : {}),
    ...(item.gender ? { gender: item.gender } : {}),
    ...(item.residence ? { residence: item.residence } : {}),
    ...(item.profileSummary ? { profileSummary: item.profileSummary } : {}),
    ...(item.sharedContext ? { sharedContext: item.sharedContext } : {})
  }));
}

// Maps stored user data to the prompt user-profile shape.
function buildUserProfilePromptState(currentUser: StoredUser, senderName?: string) {
  return {
    ...(currentUser?.userId ? { userId: currentUser.userId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(currentUser?.nickname ? { nickname: currentUser.nickname } : {}),
    ...(currentUser?.relationship ? { relationship: currentUser.relationship } : {}),
    ...(currentUser?.preferredAddress ? { preferredAddress: currentUser.preferredAddress } : {}),
    ...(currentUser?.gender ? { gender: currentUser.gender } : {}),
    ...(currentUser?.residence ? { residence: currentUser.residence } : {}),
    ...(currentUser?.profileSummary ? { profileSummary: currentUser.profileSummary } : {}),
    ...(currentUser?.sharedContext ? { sharedContext: currentUser.sharedContext } : {}),
    ...(currentUser?.memories ? { memories: currentUser.memories } : {}),
    ...(currentUser?.specialRole ? { specialRole: currentUser.specialRole } : {})
  };
}

// Resolves captions and media references before prompt rendering.
async function preparePromptMediaContext(
  deps: GenerationPromptBuilderDeps,
  input: {
    historyForPrompt: GenerationPromptHistoryMessage[];
    batchMessages?: Array<{
      attachments?: ChatAttachment[];
    }>;
    reason: string;
    abortSignal?: AbortSignal;
  }
) {
  const batchImageIds = Array.from(new Set((input.batchMessages ?? []).flatMap((message) => (
    message.attachments
      ?.filter((item) => item.kind === "image" || item.kind === "animated_image")
      .map((item) => item.fileId)
      ?? []
  ))));
  const historyImageIds = collectReferencedImageIds(input.historyForPrompt);
  const captionMap = await deps.mediaCaptionService.ensureReady(
    Array.from(new Set([...historyImageIds, ...batchImageIds])),
    {
      reason: input.reason,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    }
  );

  return {
    historyForPrompt: annotateHistoryMessagesWithCaptions(input.historyForPrompt, captionMap, { includeIds: true }),
    captionMap
  };
}

async function preparePromptBatchMessages(
  deps: GenerationPromptBuilderDeps,
  messages: GenerationPromptBatchMessage[],
  captionMap: Awaited<ReturnType<typeof preparePromptMediaContext>>["captionMap"],
  options: {
    supportsAudioInput?: boolean | undefined;
    supportsVision?: boolean | undefined;
    shouldTranscribeAudio?: boolean | undefined;
    abortSignal?: AbortSignal | undefined;
  }
) {
  return Promise.all(messages.map(async (message) => {
    const audioIds = message.audioIds ?? [];
    const imageFileIds = (message.attachments ?? [])
      .filter((item) => item.semanticKind !== "emoji" && (item.kind === "image" || item.kind === "animated_image"))
      .map((item) => item.fileId);
    const emojiFileIds = (message.attachments ?? [])
      .filter((item) => item.semanticKind === "emoji" && (item.kind === "image" || item.kind === "animated_image"))
      .map((item) => item.fileId);
    const imageVisuals = options.supportsVision
      ? await deps.mediaVisionService.prepareFilesForModel(imageFileIds)
      : [];
    const emojiVisuals = options.supportsVision
      ? await deps.mediaVisionService.prepareFilesForModel(emojiFileIds)
      : [];

    return {
      userId: message.userId,
      senderName: message.senderName,
      text: message.text,
      images: message.images,
      audioSources: message.audioSources,
      audioIds,
      ...(options.supportsAudioInput
        ? {
            audioInputs: await prepareAudioInputsForModel(message.audioSources, {
              oneBotClient: deps.oneBotClient
            })
          }
        : {}),
      ...((options.shouldTranscribeAudio && audioIds.length > 0)
        ? {
            audioTranscriptions: Array.from((await deps.audioTranscriber.ensureReady(
              audioIds,
              {
                reason: "chat_prompt_audio_transcription",
                ...(options.abortSignal ? { abortSignal: options.abortSignal } : {})
              }
            )).values()) as PromptAudioTranscription[]
          }
        : {}),
      emojiSources: message.emojiSources,
      imageIds: imageFileIds,
      imageCaptions: buildPromptImageCaptions(imageFileIds, captionMap),
      ...(options.supportsVision ? { imageVisuals: imageVisuals.map((item) => ({ imageId: item.fileId, inputUrl: item.inputUrl })) } : {}),
      emojiIds: emojiFileIds,
      emojiCaptions: buildPromptImageCaptions(emojiFileIds, captionMap),
      ...(options.supportsVision ? { emojiVisuals: emojiVisuals.map((item) => ({ imageId: item.fileId, inputUrl: item.inputUrl, animated: item.animated, durationMs: item.durationMs, sampledFrameCount: item.sampledFrameCount })) } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      forwardIds: message.forwardIds,
      replyMessageId: message.replyMessageId,
      mentionUserIds: message.mentionUserIds,
      mentionedAll: message.mentionedAll,
      mentionedSelf: message.isAtMentioned,
      timestampMs: message.receivedAt
    };
  }));
}

async function collectPromptLiveResources(deps: GenerationPromptBuilderDeps): Promise<PromptLiveResource[]> {
  const [browserPages, shellSessions] = await Promise.all([
    deps.browserService.listPages(),
    deps.shellRuntime.listSessionResources()
  ]);

  return [
    ...browserPages.pages.map((item) => ({
      resourceId: item.resource_id,
      kind: "browser_page" as const,
      status: item.status,
      title: item.title,
      description: item.description,
      summary: buildBrowserResourceSummary(item),
      lastAccessedAtMs: item.lastAccessedAtMs
    })),
    ...shellSessions.map((item) => ({
      resourceId: item.resource_id,
      kind: "shell_session" as const,
      status: item.status,
      title: item.title,
      description: item.description,
      summary: buildShellResourceSummary(item),
      lastAccessedAtMs: item.lastAccessedAtMs
    }))
  ]
    .sort(comparePromptLiveResources)
    .map(({ lastAccessedAtMs: _lastAccessedAtMs, ...item }) => item);
}

function shouldIncludeLiveResources(visibleToolNames: string[]): boolean {
  return visibleToolNames.some((name) => LIVE_RESOURCE_TOOL_NAMES.has(name));
}

function comparePromptLiveResources(left: {
  kind: PromptLiveResource["kind"];
  status: PromptLiveResource["status"];
  resourceId: string;
  lastAccessedAtMs: number;
}, right: {
  kind: PromptLiveResource["kind"];
  status: PromptLiveResource["status"];
  resourceId: string;
  lastAccessedAtMs: number;
}): number {
  const statusOrder = statusPriority(left.status) - statusPriority(right.status);
  if (statusOrder !== 0) {
    return statusOrder;
  }
  if (right.lastAccessedAtMs !== left.lastAccessedAtMs) {
    return right.lastAccessedAtMs - left.lastAccessedAtMs;
  }
  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind);
  }
  return left.resourceId.localeCompare(right.resourceId);
}

function statusPriority(status: PromptLiveResource["status"]): number {
  switch (status) {
    case "active":
      return 0;
    case "expired":
      return 1;
    case "closed":
      return 2;
    case "unrecoverable":
      return 3;
    default:
      return 4;
  }
}

function buildBrowserResourceSummary(item: {
  resolvedUrl: string;
  backend: "playwright";
  summary: string;
}): string {
  return `${item.resolvedUrl} | backend=${item.backend} | ${item.summary}`;
}

function buildShellResourceSummary(item: {
  command: string;
  cwd: string;
  tty: boolean;
}): string {
  return `${item.command.slice(0, 80)} | cwd=${item.cwd} | tty=${item.tty ? "on" : "off"}`;
}

function toImageCaptionEntries(captionMap: Awaited<ReturnType<typeof preparePromptMediaContext>>["captionMap"]) {
  return Array.from(captionMap.entries()).map(([imageId, caption]) => ({
    imageId,
    caption
  }));
}

function extractSystemMessages(promptMessages: LlmMessage[]): string[] {
  return promptMessages
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
}

// Builds chat, setup, and scheduled prompts from shared context helpers.
export function createGenerationPromptBuilder(deps: GenerationPromptBuilderDeps): GenerationPromptBuilder {
  const buildChatPromptMessages = async (input: {
    sessionId: string;
    interactionMode: PromptInteractionMode;
    mainModelRef: string[];
    visibleToolNames: string[];
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    persona: PersonaState;
    relationship: Relationship;
    participantProfiles: GenerationPromptParticipantProfile[];
    currentUser: StoredUser;
    historySummary: string | null;
    historyForPrompt: GenerationPromptHistoryMessage[];
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
  }) => {
    const mainProfile = getPrimaryModelProfile(deps.config, input.mainModelRef);
    const mediaContext = await preparePromptMediaContext(deps, {
      historyForPrompt: input.historyForPrompt,
      batchMessages: input.batchMessages,
      reason: "chat_prompt",
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });

    const relevantUserIds = new Set<string>([
      ...(input.currentUser?.userId ? [input.currentUser.userId] : []),
      ...input.participantProfiles.map((item) => item.userId),
      ...input.batchMessages.map((item) => item.userId)
    ]);
    const globalMemories = await deps.globalMemoryStore.getAll();
    const liveResources = shouldIncludeLiveResources(input.visibleToolNames)
      ? await collectPromptLiveResources(deps)
      : [];
    const preparedBatchMessages = await preparePromptBatchMessages(
      deps,
      input.batchMessages,
      mediaContext.captionMap,
      {
        supportsAudioInput: mainProfile?.supportsAudioInput,
        supportsVision: mainProfile?.supportsVision,
        shouldTranscribeAudio: !mainProfile?.supportsAudioInput,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }
    );

    const promptMessages = buildPrompt({
      sessionId: input.sessionId,
      interactionMode: input.interactionMode,
      visibleToolNames: input.visibleToolNames,
      lateSystemMessages: input.lateSystemMessages,
      replayMessages: input.replayMessages,
      persona: input.persona,
      relationship: input.relationship,
      npcProfiles: buildNpcPromptProfiles(deps, relevantUserIds),
      participantProfiles: input.participantProfiles,
      userProfile: buildUserProfilePromptState(
        input.currentUser,
        input.batchMessages[input.batchMessages.length - 1]?.senderName
      ),
      globalMemories,
      historySummary: input.historySummary,
      recentToolEvents: input.recentToolEvents,
      debugMarkers: input.debugMarkers,
      liveResources,
      recentMessages: mediaContext.historyForPrompt,
      batchMessages: preparedBatchMessages
    });

    return {
      promptMessages,
      debugSnapshot: {
        sessionId: input.sessionId,
        systemMessages: extractSystemMessages(promptMessages),
        visibleToolNames: input.visibleToolNames,
        historySummary: input.historySummary,
        recentHistory: mediaContext.historyForPrompt,
        currentBatch: input.batchMessages,
        liveResources,
        recentToolEvents: input.recentToolEvents,
        debugMarkers: input.debugMarkers ?? [],
        toolTranscript: input.internalTranscript,
        persona: input.persona,
        globalMemories,
        currentUser: input.currentUser,
        participantProfiles: input.participantProfiles,
        imageCaptions: toImageCaptionEntries(mediaContext.captionMap),
        lastLlmUsage: input.lastLlmUsage
      }
    };
  };

  const buildScheduledPromptMessages = async (input: {
    sessionId: string;
    interactionMode: PromptInteractionMode;
    visibleToolNames: string[];
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    trigger: Parameters<typeof buildScheduledTaskPrompt>[0]["trigger"];
    persona: PersonaState;
    relationship: Relationship;
    participantProfiles: GenerationPromptParticipantProfile[];
    currentUser: StoredUser;
    historySummary: string | null;
    historyForPrompt: GenerationPromptHistoryMessage[];
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    targetContext: ScheduledPromptTargetContext;
    abortSignal?: AbortSignal;
  }) => {
    const [mediaContext, liveResources, globalMemories] = await Promise.all([
      preparePromptMediaContext(deps, {
        historyForPrompt: input.historyForPrompt,
        reason: "scheduled_prompt",
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }),
      shouldIncludeLiveResources(input.visibleToolNames)
        ? collectPromptLiveResources(deps)
        : Promise.resolve([]),
      deps.globalMemoryStore.getAll()
    ]);

    const relevantUserIds = new Set<string>([
      ...(input.currentUser?.userId ? [input.currentUser.userId] : []),
      ...input.participantProfiles.map((item) => item.userId),
      ...(input.targetContext.chatType === "private" ? [input.targetContext.userId] : [])
    ]);

    const promptMessages = buildScheduledTaskPrompt({
      sessionId: input.sessionId,
      interactionMode: input.interactionMode,
      visibleToolNames: input.visibleToolNames,
      lateSystemMessages: input.lateSystemMessages,
      replayMessages: input.replayMessages,
      trigger: input.trigger,
      persona: input.persona,
      relationship: input.relationship,
      npcProfiles: buildNpcPromptProfiles(deps, relevantUserIds),
      participantProfiles: input.participantProfiles,
      userProfile: buildUserProfilePromptState(
        input.currentUser,
        input.targetContext.chatType === "private" ? input.targetContext.senderName : undefined
      ),
      globalMemories,
      historySummary: input.historySummary,
      recentToolEvents: input.recentToolEvents,
      debugMarkers: input.debugMarkers,
      liveResources,
      recentMessages: mediaContext.historyForPrompt,
      targetContext: input.targetContext
    });

    return {
      promptMessages,
      debugSnapshot: {
        sessionId: input.sessionId,
        systemMessages: extractSystemMessages(promptMessages),
        visibleToolNames: input.visibleToolNames,
        historySummary: input.historySummary,
        recentHistory: mediaContext.historyForPrompt,
        currentBatch: [],
        liveResources,
        recentToolEvents: input.recentToolEvents,
        debugMarkers: input.debugMarkers ?? [],
        toolTranscript: input.internalTranscript,
        persona: input.persona,
        globalMemories,
        currentUser: input.currentUser,
        participantProfiles: input.participantProfiles,
        imageCaptions: toImageCaptionEntries(mediaContext.captionMap),
        lastLlmUsage: input.lastLlmUsage
      }
    };
  };

  const buildSetupPromptMessages = async (input: {
    sessionId: string;
    interactionMode: PromptInteractionMode;
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    persona: PersonaState;
    historyForPrompt: GenerationPromptHistoryMessage[];
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    currentUser: StoredUser;
    participantProfiles: GenerationPromptParticipantProfile[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
  }) => {
    const mainProfile = getPrimaryModelProfile(deps.config, getDefaultMainModelRefs(deps.config));
    const mediaContext = await preparePromptMediaContext(deps, {
      historyForPrompt: input.historyForPrompt,
      batchMessages: input.batchMessages,
      reason: "setup_prompt",
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });

    const preparedBatchMessages = await preparePromptBatchMessages(
      deps,
      input.batchMessages,
      mediaContext.captionMap,
      {
        supportsAudioInput: mainProfile?.supportsAudioInput,
        supportsVision: mainProfile?.supportsVision,
        shouldTranscribeAudio: !mainProfile?.supportsAudioInput,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }
    );

    const promptMessages = buildSetupPrompt({
      sessionId: input.sessionId,
      interactionMode: input.interactionMode,
      lateSystemMessages: input.lateSystemMessages,
      replayMessages: input.replayMessages,
      includeBatchMediaCaptions: !mainProfile?.supportsVision,
      persona: input.persona,
      missingFields: deps.setupStore.describeMissingFields(input.persona).map((item) => item.key),
      recentToolEvents: input.recentToolEvents,
      debugMarkers: input.debugMarkers,
      recentMessages: mediaContext.historyForPrompt,
      batchMessages: preparedBatchMessages
    });

    return {
      promptMessages,
      debugSnapshot: {
        sessionId: input.sessionId,
        systemMessages: extractSystemMessages(promptMessages),
        visibleToolNames: [],
        historySummary: null,
        recentHistory: mediaContext.historyForPrompt,
        currentBatch: input.batchMessages,
        liveResources: [],
        recentToolEvents: input.recentToolEvents,
        debugMarkers: input.debugMarkers ?? [],
        toolTranscript: input.internalTranscript,
        persona: input.persona,
        globalMemories: [],
        currentUser: input.currentUser,
        participantProfiles: input.participantProfiles,
        imageCaptions: toImageCaptionEntries(mediaContext.captionMap),
        lastLlmUsage: input.lastLlmUsage
      }
    };
  };

  return {
    buildChatPromptMessages,
    buildScheduledPromptMessages,
    buildSetupPromptMessages
  };
}

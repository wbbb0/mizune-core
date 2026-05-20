import {
  annotateHistoryMessagesWithCaptions,
  buildPromptImageCaptions,
  collectReferencedImageIds
} from "#images/imagePromptContext.ts";
import {
  annotateStructuredMediaReferences
} from "#images/imageReferences.ts";
import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { prepareAudioInputsForModel } from "#messages/audioSources.ts";
import { buildPrompt, buildScheduledTaskPrompt, buildSetupPrompt } from "#llm/prompt/promptBuilder.ts";
import type { PromptInteractionMode, PromptLiveResource } from "#llm/prompt/promptTypes.ts";
import type { PromptAudioTranscription } from "#llm/prompt/promptTypes.ts";
import {
  audioTranscriptionsFromDerivedObservations,
  DerivedObservationReader,
  imageCaptionMapFromDerivedObservations
} from "#llm/derivations/derivedObservationReader.ts";
import type {
  InternalTranscriptItem,
  SessionDebugMarker,
  SessionUsageSnapshot
} from "#conversation/session/sessionTypes.ts";
import type { PersonaStore } from "#persona/personaStore.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { LlmMessage } from "#llm/llmClient.ts";
import type { PromptDebugSnapshot } from "#llm/tools/core/shared.ts";
import type { GenerationPromptBuilderDeps } from "./generationRunnerDeps.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import {
  collectVisualAttachmentFileIds,
  dedupeResolvedChatAttachments
} from "#services/workspace/chatAttachments.ts";
import { parseProtocolLine } from "#utils/structuredEnvelope.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import type { ToolsetRuleEntry } from "#llm/prompt/toolsetRuleStore.ts";
import { isNearDuplicateText } from "#memory/similarity.ts";
import type { UserMemoryEntry } from "#memory/userMemoryEntry.ts";
import type { ScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
import { createEmptyScenarioProfile, getMissingScenarioProfileFields } from "#modes/scenarioHost/profileSchema.ts";
import { preparePromptMemoryContext } from "#llm/prompts/chat-system.prompt.ts";
import type { PromptInput } from "#llm/prompt/promptTypes.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import type { OneBotMessageFileSummary, OneBotSpecialSegmentSummary } from "#services/onebot/types.ts";
import { buildChatFileHandleResult } from "#llm/tools/core/fileHandle.ts";
import type { ContextMemoryFactEntry, ContextPromptMemoryRetrievalSkipReason } from "#context/contextTypes.ts";
import { contextTermOverlapScore } from "#context/contextTextTerms.ts";

type PersonaState = Awaited<ReturnType<PersonaStore["get"]>>;
type StoredUser = Awaited<ReturnType<UserStore["getByUserId"]>>;
const LIVE_RESOURCE_TOOL_NAMES = new Set([
  "list_live_resources",
  "read_download_resource",
  "cancel_download_resource",
  "open_page",
  "inspect_page",
  "interact_with_page",
  "close_page",
  "terminal_list",
  "terminal_run",
  "terminal_start",
  "terminal_read",
  "terminal_write",
  "terminal_send_lines",
  "terminal_key",
  "terminal_signal",
  "terminal_stop"
]);
export interface GenerationPromptHistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestampMs?: number | null;
}

export interface GenerationPromptParticipantProfile {
  userId: string;
  displayName: string;
  relationshipLabel: string;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  timezone?: string;
  occupation?: string;
  profileSummary?: string;
  relationshipNote?: string;
}

export interface GenerationPromptBatchMessage {
  userId: string;
  senderName: string;
  text: string;
  contentParts?: MessageContentPart[];
  images: string[];
  audioSources: string[];
  audioIds: string[];
  emojiSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
  messageFiles?: OneBotMessageFileSummary[];
  specialSegments?: OneBotSpecialSegmentSummary[];
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
    modeId?: string;
    interactionMode: PromptInteractionMode;
    mainModelRef: string[];
    visibleToolNames: string[];
    activeToolsets: ToolsetView[];
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    persona: PersonaState;
    relationship: Relationship;
    participantProfiles: GenerationPromptParticipantProfile[];
    currentUser: StoredUser;
    historySummary: string | null;
    historyForPrompt: GenerationPromptHistoryMessage[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
    contentSafetyAlreadyProjected?: boolean;
    modeProfile?: PromptInput["modeProfile"];
    draftMode?: PromptInput["draftMode"];
    isInSetup?: boolean;
  }) => Promise<GenerationPromptBuildResult>;
  buildScheduledPromptMessages: (input: {
    sessionId: string;
    modeId?: string;
    interactionMode: PromptInteractionMode;
    visibleToolNames: string[];
    activeToolsets: ToolsetView[];
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    trigger: Parameters<typeof buildScheduledTaskPrompt>[0]["trigger"];
    inlineBatchMessage?: string | undefined;
    persona: PersonaState;
    relationship: Relationship;
    participantProfiles: GenerationPromptParticipantProfile[];
    currentUser: StoredUser;
    historySummary: string | null;
    historyForPrompt: GenerationPromptHistoryMessage[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    targetContext: ScheduledPromptTargetContext;
    abortSignal?: AbortSignal;
    modeProfile?: PromptInput["modeProfile"];
  }) => Promise<GenerationPromptBuildResult>;
  buildSetupPromptMessages: (input: {
    sessionId: string;
    interactionMode: PromptInteractionMode;
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    persona: PersonaState;
    phase: "setup" | "config";
    historyForPrompt: GenerationPromptHistoryMessage[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    currentUser: StoredUser;
    participantProfiles: GenerationPromptParticipantProfile[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
    contentSafetyAlreadyProjected?: boolean;
  }) => Promise<GenerationPromptBuildResult>;
}

function isScenarioHostMode(modeId?: string): boolean {
  return modeId === "scenario_host";
}

function isAssistantMode(modeId?: string): boolean {
  return modeId === "assistant";
}

function buildScenarioStateLines(state: ScenarioHostSessionState): string[] {
  return [
    `当前局势=${state.currentSituation}`,
    `当前位置=${state.currentLocation ?? "未设定"}`,
    `场景摘要=${state.sceneSummary || "无"}`,
    `主玩家=${state.player.displayName} (${state.player.userId})`,
    `背包=${state.inventory.length > 0 ? state.inventory.map((item: ScenarioHostSessionState["inventory"][number]) => `${item.ownerId}:${item.item}x${item.quantity}`).join("；") : "空"}`,
    `目标=${state.objectives.length > 0 ? state.objectives.map((item: ScenarioHostSessionState["objectives"][number]) => `${item.id}:${item.title}[${item.status}] ${item.summary}`.trim()).join("；") : "无"}`,
    `世界事实=${state.worldFacts.length > 0 ? state.worldFacts.join("；") : "无"}`,
    `标记=${Object.keys(state.flags).length > 0 ? Object.entries(state.flags).map(([key, value]) => `${key}=${String(value)}`).join("；") : "无"}`,
    `回合数=${state.turnIndex}`
  ];
}

// Converts relevant NPC records into prompt-friendly profile payloads.
function buildNpcPromptProfiles(deps: GenerationPromptBuilderDeps, relevantUserIds: Iterable<string>) {
  const relevant = new Set(Array.from(relevantUserIds));
  return deps.npcDirectory.listProfiles().filter((item) => relevant.has(item.userId)).map((item) => ({
    userId: item.userId,
    displayName: item.preferredAddress ?? item.userId,
    ...(item.preferredAddress ? { preferredAddress: item.preferredAddress } : {}),
    ...(item.gender ? { gender: item.gender } : {}),
    ...(item.residence ? { residence: item.residence } : {}),
    ...(item.timezone ? { timezone: item.timezone } : {}),
    ...(item.occupation ? { occupation: item.occupation } : {}),
    ...(item.profileSummary ? { profileSummary: item.profileSummary } : {}),
    ...(item.relationshipNote ? { relationshipNote: item.relationshipNote } : {})
  }));
}

// Maps stored user data to the prompt user-profile shape.
function buildUserProfilePromptState(currentUser: StoredUser, senderName?: string) {
  return {
    ...(currentUser?.userId ? { userId: currentUser.userId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(currentUser?.relationship ? { relationship: currentUser.relationship } : {}),
    ...(currentUser?.preferredAddress ? { preferredAddress: currentUser.preferredAddress } : {}),
    ...(currentUser?.gender ? { gender: currentUser.gender } : {}),
    ...(currentUser?.residence ? { residence: currentUser.residence } : {}),
    ...(currentUser?.timezone ? { timezone: currentUser.timezone } : {}),
    ...(currentUser?.occupation ? { occupation: currentUser.occupation } : {}),
    ...(currentUser?.profileSummary ? { profileSummary: currentUser.profileSummary } : {}),
    ...(currentUser?.relationshipNote ? { relationshipNote: currentUser.relationshipNote } : {}),
    ...(currentUser?.specialRole ? { specialRole: currentUser.specialRole } : {})
  };
}

function buildAssistantUserProfilePromptState(currentUser: StoredUser, senderName?: string) {
  return {
    ...(currentUser?.userId ? { userId: currentUser.userId } : {}),
    ...(senderName ? { senderName } : {})
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
    replayMessages?: LlmMessage[];
    reason: string;
    abortSignal?: AbortSignal;
  }
) {
  const batchImageIds = Array.from(new Set((input.batchMessages ?? []).flatMap((message) => (
    [
      ...collectVisualAttachmentFileIds(message.attachments, "image"),
      ...collectVisualAttachmentFileIds(message.attachments, "emoji")
    ]
  ))));
  const historyImageIds = collectReferencedImageIds(input.historyForPrompt);
  const replayStringMessages = collectReplayStringMessages(input.replayMessages);
  const replayImageIds = collectReferencedImageIds(replayStringMessages);
  const imageIds = Array.from(new Set([...historyImageIds, ...replayImageIds, ...batchImageIds]));
  const fallbackCaptionMap = await deps.mediaCaptionService.ensureReady(
    imageIds,
    {
      reason: input.reason,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    }
  );
  const captionMap = await readImageCaptionMapFromDerivedObservations(deps, imageIds, fallbackCaptionMap);
  const audioTranscriptionMap = await preparePromptAudioTranscriptionMap(deps, [
    ...collectReferencedAudioIds(input.historyForPrompt),
    ...collectReferencedAudioIds(replayStringMessages)
  ], {
    reason: input.reason,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
  });

  return {
    historyForPrompt: annotateHistoryMessagesWithAudioTranscriptions(
      annotateHistoryMessagesWithCaptions(input.historyForPrompt, captionMap, { includeIds: true }),
      audioTranscriptionMap
    ),
    captionMap,
    audioTranscriptionMap
  };
}

function collectReplayStringMessages(replayMessages: LlmMessage[] | undefined): Array<{ content: string }> {
  return (replayMessages ?? [])
    .map((message) => typeof message.content === "string" ? { content: message.content } : null)
    .filter((message): message is { content: string } => message != null);
}

function collectReferencedAudioIds(messages: Array<{ content: string }>): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const line of message.content.replace(/\r\n/g, "\n").split("\n")) {
      const parsed = parseProtocolLine(line);
      if (parsed?.tag !== "audio") {
        continue;
      }
      const audioId = String(parsed.attrs.audio_id ?? "").trim();
      if (audioId) {
        ids.add(audioId);
      }
    }
  }
  return Array.from(ids);
}

async function preparePromptAudioTranscriptionMap(
  deps: GenerationPromptBuilderDeps,
  audioIds: string[],
  options: {
    reason: string;
    abortSignal?: AbortSignal | undefined;
  }
): Promise<Map<string, PromptAudioTranscription>> {
  const uniqueAudioIds = Array.from(new Set(audioIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
  if (uniqueAudioIds.length === 0) {
    return new Map();
  }
  const transcriptions = await preparePromptAudioTranscriptions(deps, uniqueAudioIds, options);
  return new Map(transcriptions.map((item) => [item.audioId, item]));
}

function annotateHistoryMessagesWithAudioTranscriptions<T extends { content: string }>(
  messages: T[],
  transcriptions: ReadonlyMap<string, PromptAudioTranscription>
): T[] {
  if (transcriptions.size === 0) {
    return messages;
  }
  return messages.map((message) => ({
    ...message,
    content: annotateAudioReferences(message.content, transcriptions)
  }));
}

function annotateReplayMessagesWithDerivedContext(
  replayMessages: LlmMessage[] | undefined,
  captions: ReadonlyMap<string, string>,
  transcriptions: ReadonlyMap<string, PromptAudioTranscription>
): LlmMessage[] | undefined {
  if (!replayMessages || (captions.size === 0 && transcriptions.size === 0)) {
    return replayMessages;
  }
  return replayMessages.map((message) => {
    if (typeof message.content !== "string") {
      return message;
    }
    const withCaptions = annotateStructuredMediaReferences(message.content, captions, { includeIds: true });
    const withAudio = annotateAudioReferences(withCaptions, transcriptions);
    return {
      ...message,
      content: withAudio
    };
  });
}

function annotateAudioReferences(
  content: string,
  transcriptions: ReadonlyMap<string, PromptAudioTranscription>
): string {
  return content.replace(/\r\n/g, "\n").split("\n").map((line) => {
    const parsed = parseProtocolLine(line);
    if (parsed?.tag !== "audio") {
      return line;
    }
    const audioId = String(parsed.attrs.audio_id ?? "").trim();
    const transcription = transcriptions.get(audioId);
    if (!transcription) {
      return line;
    }
    if (transcription.status === "ready" && transcription.text) {
      return `${line}\n音频 ${audioId} 听写：${transcription.text}`;
    }
    return `${line}\n音频 ${audioId} 听写失败：${transcription.error ?? "未配置可用听写模型或内容无法识别"}`;
  }).join("\n");
}

async function projectPromptContentSafety<
  H extends GenerationPromptHistoryMessage,
  B extends GenerationPromptBatchMessage
>(
  deps: GenerationPromptBuilderDeps,
  input: {
    sessionId: string;
    source: string;
    historyForPrompt: H[];
    batchMessages: B[];
    abortSignal?: AbortSignal | undefined;
    contentSafetyAlreadyProjected?: boolean | undefined;
  }
): Promise<{ historyForPrompt: H[]; batchMessages: B[] }> {
  if (input.contentSafetyAlreadyProjected === true) {
    return {
      historyForPrompt: input.historyForPrompt,
      batchMessages: input.batchMessages
    };
  }
  const projected = await deps.contentSafetyService?.projectPromptMessages({
    sessionId: input.sessionId,
    source: input.source,
    recentMessages: input.historyForPrompt,
    batchMessages: input.batchMessages,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
  });
  if (!projected) {
    return {
      historyForPrompt: input.historyForPrompt,
      batchMessages: input.batchMessages
    };
  }
  return {
    historyForPrompt: projected.recentMessages,
    batchMessages: projected.batchMessages
  };
}

async function projectReplayMessages(
  deps: GenerationPromptBuilderDeps,
  input: {
    sessionId: string;
    source: string;
    replayMessages?: LlmMessage[] | undefined;
    abortSignal?: AbortSignal | undefined;
  }
): Promise<LlmMessage[] | undefined> {
  if (!input.replayMessages || input.replayMessages.length === 0) {
    return input.replayMessages;
  }
  const projected = await deps.contentSafetyService?.projectLlmMessages({
    sessionId: input.sessionId,
    source: input.source,
    messages: input.replayMessages,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
  });
  return projected?.messages ?? input.replayMessages;
}

async function projectPromptMessageAtIndex(
  deps: GenerationPromptBuilderDeps,
  input: {
    sessionId: string;
    source: string;
    messages: LlmMessage[];
    index: number;
    abortSignal?: AbortSignal | undefined;
  }
): Promise<LlmMessage[]> {
  const message = input.messages[input.index];
  if (!message) {
    return input.messages;
  }
  const projected = await deps.contentSafetyService?.projectLlmMessages({
    sessionId: input.sessionId,
    source: input.source,
    messages: [message],
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
  });
  const projectedMessage = projected?.messages[0];
  if (!projectedMessage) {
    return input.messages;
  }
  return input.messages.map((item, index) => index === input.index ? projectedMessage : item);
}

async function readImageCaptionMapFromDerivedObservations(
  deps: GenerationPromptBuilderDeps,
  imageIds: string[],
  fallbackCaptionMap: Map<string, string>
): Promise<Map<string, string>> {
  if (imageIds.length === 0 || typeof deps.chatFileStore.getMany !== "function") {
    return fallbackCaptionMap;
  }
  const observations = await new DerivedObservationReader({
    chatFileStore: deps.chatFileStore
  }).read({ chatFileIds: imageIds });
  return imageCaptionMapFromDerivedObservations(observations);
}

async function preparePromptBatchMessages(
  deps: GenerationPromptBuilderDeps,
  messages: GenerationPromptBatchMessage[],
  captionMap: Awaited<ReturnType<typeof preparePromptMediaContext>>["captionMap"],
  options: {
    supportsAudioInput?: boolean | undefined;
    supportsVision?: boolean | undefined;
    shouldTranscribeAudio?: boolean | undefined;
    visibleToolNames?: string[] | undefined;
    abortSignal?: AbortSignal | undefined;
  }
) {
  return Promise.all(messages.map(async (message) => {
    const audioIds = message.audioIds ?? [];
    const attachments = dedupeResolvedChatAttachments(message.attachments ?? []);
    const imageFileIds = collectVisualAttachmentFileIds(attachments, "image");
    const emojiFileIds = collectVisualAttachmentFileIds(attachments, "emoji");
    const assetFileIds = collectPromptAssetAttachmentFileIds(attachments);
    const assetFiles = assetFileIds.length > 0
      ? new Map((await deps.chatFileStore.getMany(assetFileIds)).map((file) => [file.fileId, file]))
      : new Map();
    const assetHandles = assetFileIds
      .map((fileId) => assetFiles.get(fileId))
      .filter((file): file is NonNullable<typeof file> => Boolean(file))
      .map((file) => buildChatFileHandleResult(file, {
            visibleToolNames: options.visibleToolNames ?? [],
            defaultVisible: false,
            nextActionMode: "default"
          }).asset_handle);
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
      ...(message.contentParts && message.contentParts.length > 0 ? { contentParts: message.contentParts } : {}),
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
            audioTranscriptions: await preparePromptAudioTranscriptions(deps, audioIds, options)
          }
        : {}),
      emojiSources: message.emojiSources,
      imageIds: imageFileIds,
      imageCaptions: buildPromptImageCaptions(imageFileIds, captionMap),
      ...(options.supportsVision ? { imageVisuals: imageVisuals.map((item) => ({ imageId: item.fileId, inputUrl: item.inputUrl })) } : {}),
      emojiIds: emojiFileIds,
      emojiCaptions: buildPromptImageCaptions(emojiFileIds, captionMap),
      ...(options.supportsVision ? { emojiVisuals: emojiVisuals.map((item) => ({ imageId: item.fileId, inputUrl: item.inputUrl, animated: item.animated, durationMs: item.durationMs, sampledFrameCount: item.sampledFrameCount })) } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(assetHandles.length > 0 ? { assetHandles } : {}),
      ...(message.messageFiles && message.messageFiles.length > 0 ? { messageFiles: message.messageFiles } : {}),
      ...(message.specialSegments && message.specialSegments.length > 0 ? { specialSegments: message.specialSegments } : {}),
      forwardIds: message.forwardIds,
      replyMessageId: message.replyMessageId,
      mentionUserIds: message.mentionUserIds,
      mentionedAll: message.mentionedAll,
      mentionedSelf: message.isAtMentioned,
      timestampMs: message.receivedAt
    };
  }));
}

function collectPromptAssetAttachmentFileIds(attachments: ChatAttachment[]): string[] {
  const visualIds = new Set([
    ...collectVisualAttachmentFileIds(attachments, "image"),
    ...collectVisualAttachmentFileIds(attachments, "emoji")
  ]);
  return attachments
    .filter((attachment) => attachment.kind === "file" && !visualIds.has(attachment.fileId))
    .map((attachment) => attachment.fileId);
}

async function preparePromptAudioTranscriptions(
  deps: GenerationPromptBuilderDeps,
  audioIds: string[],
  options: {
    abortSignal?: AbortSignal | undefined;
  }
): Promise<PromptAudioTranscription[]> {
  const fallbackResults = Array.from((await deps.audioTranscriber.ensureReady(
    audioIds,
    {
      reason: "chat_prompt_audio_transcription",
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {})
    }
  )).values()) as PromptAudioTranscription[];

  if (typeof deps.audioStore.getMany !== "function") {
    return fallbackResults;
  }
  const observations = await new DerivedObservationReader({
    audioStore: deps.audioStore
  }).read({ audioIds });
  return audioTranscriptionsFromDerivedObservations(observations, audioIds);
}

type PreparedPromptBatchMessage = Awaited<ReturnType<typeof preparePromptBatchMessages>>[number];

async function projectPreparedBatchDerivedText(
  deps: GenerationPromptBuilderDeps,
  input: {
    sessionId: string;
    source: string;
    batchMessages: PreparedPromptBatchMessage[];
    abortSignal?: AbortSignal | undefined;
  }
): Promise<PreparedPromptBatchMessage[]> {
  if (!deps.contentSafetyService) {
    return input.batchMessages;
  }

  const messages = input.batchMessages.map((message) => ({
    ...message,
    ...(message.audioTranscriptions ? { audioTranscriptions: message.audioTranscriptions.map((item) => ({ ...item })) } : {}),
    ...(message.imageCaptions ? { imageCaptions: message.imageCaptions.map((item) => ({ ...item })) } : {}),
    ...(message.emojiCaptions ? { emojiCaptions: message.emojiCaptions.map((item) => ({ ...item })) } : {})
  }));
  const refs: Array<{
    messageIndex: number;
    collection: "audioTranscriptions" | "imageCaptions" | "emojiCaptions";
    itemIndex: number;
    field: "text" | "caption";
  }> = [];
  const llmMessages: LlmMessage[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    for (const [itemIndex, transcription] of (message.audioTranscriptions ?? []).entries()) {
      if (transcription.status === "ready" && transcription.text?.trim()) {
        refs.push({ messageIndex, collection: "audioTranscriptions", itemIndex, field: "text" });
        llmMessages.push({ role: "user", content: transcription.text });
      }
    }
    for (const [itemIndex, caption] of (message.imageCaptions ?? []).entries()) {
      if (caption.caption.trim()) {
        refs.push({ messageIndex, collection: "imageCaptions", itemIndex, field: "caption" });
        llmMessages.push({ role: "user", content: caption.caption });
      }
    }
    for (const [itemIndex, caption] of (message.emojiCaptions ?? []).entries()) {
      if (caption.caption.trim()) {
        refs.push({ messageIndex, collection: "emojiCaptions", itemIndex, field: "caption" });
        llmMessages.push({ role: "user", content: caption.caption });
      }
    }
  }

  if (llmMessages.length === 0) {
    return messages;
  }

  const projected = await deps.contentSafetyService.projectLlmMessages({
    sessionId: input.sessionId,
    source: input.source,
    messages: llmMessages,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
  });

  for (const [index, ref] of refs.entries()) {
    const content = projected.messages[index]?.content;
    if (typeof content !== "string") {
      continue;
    }
    const message = messages[ref.messageIndex];
    const collection = message?.[ref.collection];
    const item = collection?.[ref.itemIndex];
    if (!message || !collection || !item) {
      continue;
    }
    if (ref.collection === "audioTranscriptions" && ref.field === "text") {
      collection[ref.itemIndex] = {
        ...item,
        text: content
      };
      continue;
    }
    collection[ref.itemIndex] = {
      ...item,
      caption: content
    };
  }

  return messages;
}

async function collectPromptLiveResources(deps: GenerationPromptBuilderDeps): Promise<PromptLiveResource[]> {
  const [browserPages, shellSessions] = await Promise.all([
    deps.browserService.listPages(),
    deps.shellRuntime.listSessionResources()
  ]);
  const downloads = deps.downloadRuntime.list();

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
    })),
    ...downloads.map((item) => ({
      resourceId: item.resource_id,
      kind: "download" as const,
      status: downloadStatusToPromptStatus(item.status),
      title: item.source_name,
      description: item.source_url,
      summary: buildDownloadResourceSummary(item),
      lastAccessedAtMs: item.updated_at_ms
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

function downloadStatusToPromptStatus(status: "running" | "completed" | "failed" | "cancelled"): PromptLiveResource["status"] {
  if (status === "running") return "active";
  if (status === "failed") return "unrecoverable";
  return "closed";
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

function buildDownloadResourceSummary(item: {
  status: "running" | "completed" | "failed" | "cancelled";
  downloaded_bytes: number;
  total_bytes: number | null;
  percent: number | null;
  file_ref: string | null;
  error: string | null;
}): string {
  return [
    `status=${item.status}`,
    item.percent != null ? `progress=${item.percent}%` : `bytes=${item.downloaded_bytes}${item.total_bytes != null ? `/${item.total_bytes}` : ""}`,
    item.file_ref ? `asset_ref=${item.file_ref}` : null,
    item.error ? `error=${item.error}` : null
  ].filter((part): part is string => Boolean(part)).join(" | ");
}

function toImageCaptionEntries(captionMap: Awaited<ReturnType<typeof preparePromptMediaContext>>["captionMap"]) {
  return Array.from(captionMap.entries()).map(([imageId, caption]) => ({
    imageId,
    caption
  }));
}

function buildBatchQueryText(messages: GenerationPromptBatchMessage[]): string {
  return messages
    .map((message) => [message.senderName, message.text].filter(Boolean).join("："))
    .filter((item) => item.trim().length > 0)
    .join("\n")
    .trim();
}

function buildScheduledQueryText(trigger: Parameters<typeof buildScheduledTaskPrompt>[0]["trigger"]): string {
  switch (trigger.kind) {
    case "scheduled_instruction":
      return `${trigger.jobName}\n${trigger.taskInstruction}`.trim();
    case "comfy_task_completed":
      return `${trigger.jobName}\n${trigger.taskInstruction}\n${trigger.positivePrompt}`.trim();
    case "comfy_task_failed":
      return `${trigger.jobName}\n${trigger.taskInstruction}\n${trigger.lastError}`.trim();
    case "download_completed":
      return `${trigger.jobName}\n${trigger.taskInstruction}\n${trigger.fileRef}\n${trigger.sourceName}`.trim();
    case "download_failed":
      return `${trigger.jobName}\n${trigger.taskInstruction}\n${trigger.error}`.trim();
    default:
      return "";
  }
}

async function enrichScheduledPromptTrigger(
  deps: GenerationPromptBuilderDeps,
  trigger: Parameters<typeof buildScheduledTaskPrompt>[0]["trigger"],
  visibleToolNames: string[]
): Promise<Parameters<typeof buildScheduledTaskPrompt>[0]["trigger"]> {
  if (trigger.kind === "comfy_task_completed" && trigger.workspaceFileIds.length > 0) {
    try {
      const files = await deps.chatFileStore.getMany(trigger.workspaceFileIds);
      const fileHandleResults = files.map((file) =>
        buildChatFileHandleResult(file, {
          visibleToolNames,
          defaultVisible: false,
          nextActionMode: "default"
        })
      );
      return fileHandleResults.length > 0
        ? {
            ...trigger,
            resultAssetHandles: fileHandleResults.map((item) => item.asset_handle)
          }
        : trigger;
    } catch (error: unknown) {
      deps.logger?.warn({ err: error }, "failed to enrich comfy scheduled prompt with result file handles");
      return trigger;
    }
  }
  if (trigger.kind === "download_completed" && trigger.fileId) {
    try {
      const file = await deps.chatFileStore.getFile(trigger.fileId);
      if (!file) {
        return trigger;
      }
      const result = buildChatFileHandleResult(file, {
        visibleToolNames,
        defaultVisible: false,
        nextActionMode: "default"
      });
      return {
        ...trigger,
        resultAssetHandle: result.asset_handle
      };
    } catch (error: unknown) {
      deps.logger?.warn({ err: error }, "failed to enrich download scheduled prompt with result file handle");
      return trigger;
    }
  }
  return trigger;
}

function selectFixedPromptFacts(
  facts: ContextMemoryFactEntry[],
  limit: number,
  options: {
    queryText?: string;
  } = {}
): {
  items: ContextMemoryFactEntry[];
  totalCount: number;
  limit: number;
  truncated: boolean;
} {
  const normalizedLimit = Math.max(0, Math.trunc(limit));
  const sortedFacts = sortPromptFacts(facts, options.queryText ?? "");
  return {
    items: normalizedLimit === 0 ? [] : sortedFacts.slice(0, normalizedLimit),
    totalCount: facts.length,
    limit: normalizedLimit,
    truncated: facts.length > normalizedLimit
  };
}

function sortPromptFacts(facts: ContextMemoryFactEntry[], queryText: string): ContextMemoryFactEntry[] {
  const now = Date.now();
  return facts
    .map((fact) => ({
      fact,
      score: scorePromptFact(fact, queryText, now)
    }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return right.fact.updatedAt - left.fact.updatedAt;
    })
    .map((item) => item.fact);
}

function listUserPromptFactsForPrompt(
  deps: GenerationPromptBuilderDeps,
  userId: string
): ContextMemoryFactEntry[] {
  return deps.contextStore?.listUserPromptFacts(userId) ?? [];
}

function scorePromptFact(fact: ContextMemoryFactEntry, queryText: string, now: number): number {
  const kindWeight = ({
    boundary: 8,
    preference: 6,
    relationship: 5,
    habit: 4,
    fact: 3,
    other: 1
  } satisfies Record<ContextMemoryFactEntry["kind"], number>)[fact.kind];
  const importanceWeight = (fact.importance ?? 0) * 2;
  const relevanceText = [fact.title, fact.content, fact.slotKey].filter(Boolean).join("\n");
  const relevanceWeight = queryText.trim()
    ? contextTermOverlapScore(queryText, relevanceText) * 8
    : 0;
  const recencyWeight = Math.max(0, 2 - ((now - fact.updatedAt) / (45 * 24 * 60 * 60 * 1000)));
  const lastUsedWeight = fact.lastUsedAt
    ? Math.max(0.5, 2 - ((now - fact.lastUsedAt) / (30 * 24 * 60 * 60 * 1000)))
    : 0;
  return kindWeight + importanceWeight + relevanceWeight + recencyWeight + lastUsedWeight;
}

function resolvePromptMemoryRetrievalSkippedReason(input: {
  scenarioHostMode: boolean;
  assistantMode: boolean;
  userId: string | undefined;
  serviceAvailable: boolean;
}): ContextPromptMemoryRetrievalSkipReason | undefined {
  if (input.scenarioHostMode) {
    return "scenario_host_mode";
  }
  if (input.assistantMode) {
    // TODO: Revisit assistant-mode memory policy. It should likely allow task/work
    // memories while still excluding persona/RP relationship context.
    return "assistant_mode";
  }
  if (!input.userId) {
    return "missing_user";
  }
  if (!input.serviceAvailable) {
    return "service_unavailable";
  }
  return undefined;
}

function extractSystemMessages(promptMessages: LlmMessage[]): string[] {
  return promptMessages
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
}

function resolveToolsetRules(
  rules: ToolsetRuleEntry[],
  input: {
    activeToolsets: ToolsetView[];
  }
): ToolsetRuleEntry[] {
  if (rules.length === 0) {
    return [];
  }

  const activeToolsetIds = new Set(input.activeToolsets.map((item) => item.id));
  const selected = rules.filter((rule) => rule.toolsetIds.some((id) => activeToolsetIds.has(id)));
  const deduped: ToolsetRuleEntry[] = [];
  for (const rule of selected) {
    const exists = deduped.some((item) => (
      item.id === rule.id
      || isNearDuplicateText(
        `${rule.title} ${rule.content} ${rule.toolsetIds.join(" ")}`,
        [`${item.title} ${item.content} ${item.toolsetIds.join(" ")}`]
      )
    ));
    if (!exists) {
      deduped.push(rule);
    }
  }
  return deduped;
}

function logPromptMemorySuppressions(
  deps: Pick<GenerationPromptBuilderDeps, "logger">,
  input: {
    sessionId: string;
    modeId?: string;
    persona: PersonaState;
    userProfile: ReturnType<typeof buildUserProfilePromptState>;
    globalRules: Awaited<ReturnType<GenerationPromptBuilderDeps["globalRuleStore"]["getAll"]>>;
    toolsetRules: ToolsetRuleEntry[];
    currentUserMemories: UserMemoryEntry[];
  }
): void {
  if (!deps.logger || input.modeId === "scenario_host") {
    return;
  }
  const prepared = preparePromptMemoryContext({
    persona: input.persona,
    globalRules: input.globalRules,
    toolsetRules: input.toolsetRules,
    userProfile: input.userProfile,
    userMemories: input.currentUserMemories
  });
  if (prepared.suppressions.length === 0) {
    return;
  }
  deps.logger.info({
    sessionId: input.sessionId,
    suppressionCount: prepared.suppressions.length,
    suppressions: prepared.suppressions
  }, "prompt_memory_items_suppressed");
}

// Builds chat, setup, and scheduled prompts from shared context helpers.
export function createGenerationPromptBuilder(deps: GenerationPromptBuilderDeps): GenerationPromptBuilder {
  const buildChatPromptMessages = async (input: {
    sessionId: string;
    modeId?: string;
    interactionMode: PromptInteractionMode;
    mainModelRef: string[];
    visibleToolNames: string[];
    activeToolsets: ToolsetView[];
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    persona: PersonaState;
    relationship: Relationship;
    participantProfiles: GenerationPromptParticipantProfile[];
    currentUser: StoredUser;
    historySummary: string | null;
    historyForPrompt: GenerationPromptHistoryMessage[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
    contentSafetyAlreadyProjected?: boolean;
    modeProfile?: PromptInput["modeProfile"];
    draftMode?: PromptInput["draftMode"];
    isInSetup?: boolean;
  }) => {
    const scenarioHostMode = isScenarioHostMode(input.modeId);
    const assistantMode = isAssistantMode(input.modeId);
    const draftMode = input.draftMode ?? (
      input.isInSetup
        ? {
            target: "scenario" as const,
            phase: "setup" as const,
            profile: createEmptyScenarioProfile(),
            missingFields: getMissingScenarioProfileFields(createEmptyScenarioProfile())
          }
        : null
    );
    const draftScopedMode = draftMode != null;
    const mainProfile = getPrimaryModelProfile(deps.config, input.mainModelRef);
    const safetyProjected = await projectPromptContentSafety(deps, {
      sessionId: input.sessionId,
      source: "chat_prompt",
      historyForPrompt: input.historyForPrompt,
      batchMessages: input.batchMessages,
      contentSafetyAlreadyProjected: input.contentSafetyAlreadyProjected,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    const mediaContext = await preparePromptMediaContext(deps, {
      historyForPrompt: safetyProjected.historyForPrompt,
      batchMessages: safetyProjected.batchMessages,
      ...(input.replayMessages ? { replayMessages: input.replayMessages } : {}),
      reason: "chat_prompt",
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });

    const relevantUserIds = new Set<string>([
      ...(input.currentUser?.userId ? [input.currentUser.userId] : []),
      ...input.participantProfiles.map((item) => item.userId),
      ...safetyProjected.batchMessages.map((item) => item.userId)
    ]);
    const globalRules = (scenarioHostMode || assistantMode || draftScopedMode)
      ? []
      : await deps.globalRuleStore.getAll();
    const toolsetRules = (scenarioHostMode || assistantMode || draftScopedMode)
      ? []
      : resolveToolsetRules(await deps.toolsetRuleStore.getAll(), {
          activeToolsets: input.activeToolsets
        });
    const scenarioState = (scenarioHostMode && !draftScopedMode)
      ? await deps.scenarioHostStateStore.ensure(input.sessionId, {
          playerUserId: input.currentUser?.userId ?? safetyProjected.batchMessages[safetyProjected.batchMessages.length - 1]?.userId ?? "unknown_user",
          playerDisplayName: input.currentUser?.preferredAddress
            ?? safetyProjected.batchMessages[safetyProjected.batchMessages.length - 1]?.senderName
            ?? input.currentUser?.userId
            ?? "玩家"
        })
      : null;
    const liveResources = shouldIncludeLiveResources(input.visibleToolNames)
      ? await collectPromptLiveResources(deps)
      : [];
    const rawPreparedBatchMessages = await preparePromptBatchMessages(
      deps,
      safetyProjected.batchMessages,
      mediaContext.captionMap,
      {
        supportsAudioInput: mainProfile?.supportsAudioInput,
        supportsVision: mainProfile?.supportsVision,
        shouldTranscribeAudio: !mainProfile?.supportsAudioInput,
        visibleToolNames: input.visibleToolNames,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }
    );
    const preparedBatchMessages = await projectPreparedBatchDerivedText(deps, {
      sessionId: input.sessionId,
      source: "chat_prompt_derived_text",
      batchMessages: rawPreparedBatchMessages,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    const replayMessages = await projectReplayMessages(deps, {
      sessionId: input.sessionId,
      source: "chat_prompt_replay",
      replayMessages: annotateReplayMessagesWithDerivedContext(
        input.replayMessages,
        mediaContext.captionMap,
        mediaContext.audioTranscriptionMap
      ),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    const userProfilePromptState = assistantMode
      ? buildAssistantUserProfilePromptState(
          input.currentUser,
          safetyProjected.batchMessages[safetyProjected.batchMessages.length - 1]?.senderName
        )
      : buildUserProfilePromptState(
          input.currentUser,
          safetyProjected.batchMessages[safetyProjected.batchMessages.length - 1]?.senderName
        );
    const allCurrentUserMemories = (scenarioHostMode || assistantMode || !input.currentUser?.userId)
      ? []
      : listUserPromptFactsForPrompt(deps, input.currentUser.userId);
    const memoryQueryText = buildBatchQueryText(input.batchMessages);
    const userFactSelection = selectFixedPromptFacts(allCurrentUserMemories, deps.config.context.retrieval.maxFixedUserFacts, {
      queryText: memoryQueryText
    });
    const currentUserMemories = userFactSelection.items;
    const allCurrentSessionContext = scenarioHostMode
      ? []
      : deps.contextStore?.listSessionFacts?.(input.sessionId) ?? [];
    const sessionFactSelection = selectFixedPromptFacts(allCurrentSessionContext, deps.config.context.retrieval.maxFixedSessionFacts, {
      queryText: memoryQueryText
    });
    const currentSessionContext = sessionFactSelection.items;
    const semanticRetrievalSkippedReason = resolvePromptMemoryRetrievalSkippedReason({
      scenarioHostMode,
      assistantMode,
      userId: input.currentUser?.userId,
      serviceAvailable: Boolean(deps.contextRetrievalService?.retrieveUserContext)
    });
    const retrievedUserContext = semanticRetrievalSkippedReason
      ? []
      : await deps.contextRetrievalService?.retrieveUserContext({
          userId: input.currentUser!.userId,
          queryText: memoryQueryText,
          excludeItemIds: currentUserMemories.map((item) => item.id),
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        }) ?? [];
    deps.contextRetrievalService?.recordPromptMemoryReport?.({
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.currentUser?.userId ? { userId: input.currentUser.userId } : {}),
      queryText: memoryQueryText,
      currentUserMemories,
      availableUserFactCount: userFactSelection.totalCount,
      userFactLimit: userFactSelection.limit,
      currentSessionContext,
      availableSessionFactCount: sessionFactSelection.totalCount,
      sessionFactLimit: sessionFactSelection.limit,
      retrievedUserContext,
      semanticRetrievalAttempted: !semanticRetrievalSkippedReason,
      ...(semanticRetrievalSkippedReason ? { semanticRetrievalSkippedReason } : {})
    });
    logPromptMemorySuppressions(deps, {
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      persona: input.persona,
      userProfile: userProfilePromptState,
      globalRules,
      toolsetRules,
      currentUserMemories
    });

    const promptMessages = buildPrompt({
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      interactionMode: input.interactionMode,
      visibleToolNames: input.visibleToolNames,
      activeToolsets: input.activeToolsets,
      lateSystemMessages: input.lateSystemMessages,
      replayMessages,
      persona: input.persona,
      relationship: input.relationship,
      npcProfiles: assistantMode ? [] : buildNpcPromptProfiles(deps, relevantUserIds),
      participantProfiles: assistantMode ? [] : input.participantProfiles,
      userProfile: assistantMode
        ? buildAssistantUserProfilePromptState(
            input.currentUser,
            safetyProjected.batchMessages[safetyProjected.batchMessages.length - 1]?.senderName
          )
        : userProfilePromptState,
      currentSessionContext,
      currentUserMemories,
      retrievedUserContext,
      globalRules,
      historySummary: input.historySummary,
      debugMarkers: input.debugMarkers,
      liveResources,
      toolsetRules,
      ...(scenarioState ? { scenarioStateLines: buildScenarioStateLines(scenarioState) } : {}),
      ...(input.modeProfile ? { modeProfile: input.modeProfile } : {}),
      ...(draftMode ? { draftMode } : {}),
      recentMessages: mediaContext.historyForPrompt,
      batchMessages: preparedBatchMessages
    });

    return {
      promptMessages,
      debugSnapshot: {
        sessionId: input.sessionId,
        systemMessages: extractSystemMessages(promptMessages),
        visibleToolNames: input.visibleToolNames,
        activeToolsets: input.activeToolsets,
        historySummary: input.historySummary,
        recentHistory: mediaContext.historyForPrompt,
        currentBatch: safetyProjected.batchMessages,
        liveResources,
        debugMarkers: input.debugMarkers ?? [],
        toolTranscript: input.internalTranscript,
        persona: input.persona,
        globalRules,
        toolsetRules,
        currentUser: assistantMode ? null : input.currentUser,
        participantProfiles: assistantMode ? [] : input.participantProfiles,
        imageCaptions: toImageCaptionEntries(mediaContext.captionMap),
        lastLlmUsage: input.lastLlmUsage
      }
    };
  };

  const buildScheduledPromptMessages = async (input: {
    sessionId: string;
    modeId?: string;
    interactionMode: PromptInteractionMode;
    visibleToolNames: string[];
    activeToolsets: ToolsetView[];
    lateSystemMessages?: string[];
    replayMessages?: LlmMessage[];
    trigger: Parameters<typeof buildScheduledTaskPrompt>[0]["trigger"];
    inlineBatchMessage?: string | undefined;
    persona: PersonaState;
    relationship: Relationship;
    participantProfiles: GenerationPromptParticipantProfile[];
    currentUser: StoredUser;
    historySummary: string | null;
    historyForPrompt: GenerationPromptHistoryMessage[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    targetContext: ScheduledPromptTargetContext;
    abortSignal?: AbortSignal;
    modeProfile?: PromptInput["modeProfile"];
  }) => {
    const scenarioHostMode = isScenarioHostMode(input.modeId);
    const assistantMode = isAssistantMode(input.modeId);
    const safetyProjected = await projectPromptContentSafety(deps, {
      sessionId: input.sessionId,
      source: "scheduled_prompt",
      historyForPrompt: input.historyForPrompt,
      batchMessages: [],
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    const [mediaContext, liveResources, globalRules, toolsetRuleEntries, scheduledTrigger] = await Promise.all([
      preparePromptMediaContext(deps, {
        historyForPrompt: safetyProjected.historyForPrompt,
        ...(input.replayMessages ? { replayMessages: input.replayMessages } : {}),
        reason: "scheduled_prompt",
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }),
      shouldIncludeLiveResources(input.visibleToolNames)
        ? collectPromptLiveResources(deps)
        : Promise.resolve([]),
      (scenarioHostMode || assistantMode) ? Promise.resolve([]) : deps.globalRuleStore.getAll(),
      (scenarioHostMode || assistantMode) ? Promise.resolve([]) : deps.toolsetRuleStore.getAll(),
      enrichScheduledPromptTrigger(deps, input.trigger, input.visibleToolNames)
    ]);
    const toolsetRules = resolveToolsetRules(toolsetRuleEntries, {
      activeToolsets: input.activeToolsets
    });
    const scenarioState = scenarioHostMode
      ? await deps.scenarioHostStateStore.ensure(input.sessionId, {
          playerUserId: input.currentUser?.userId ?? (input.targetContext.chatType === "private" ? input.targetContext.userId : "unknown_user"),
          playerDisplayName: input.currentUser?.preferredAddress
            ?? (input.targetContext.chatType === "private" ? input.targetContext.senderName : "玩家")
        })
      : null;

    const relevantUserIds = new Set<string>([
      ...(input.currentUser?.userId ? [input.currentUser.userId] : []),
      ...input.participantProfiles.map((item) => item.userId),
      ...(input.targetContext.chatType === "private" ? [input.targetContext.userId] : [])
    ]);
    const userProfilePromptState = assistantMode
      ? buildAssistantUserProfilePromptState(
          input.currentUser,
          input.targetContext.chatType === "private" ? input.targetContext.senderName : undefined
        )
      : buildUserProfilePromptState(
          input.currentUser,
          input.targetContext.chatType === "private" ? input.targetContext.senderName : undefined
        );
    const allCurrentUserMemories = (scenarioHostMode || assistantMode || !input.currentUser?.userId)
      ? []
      : listUserPromptFactsForPrompt(deps, input.currentUser.userId);
    const memoryQueryText = buildScheduledQueryText(scheduledTrigger);
    const userFactSelection = selectFixedPromptFacts(allCurrentUserMemories, deps.config.context.retrieval.maxFixedUserFacts, {
      queryText: memoryQueryText
    });
    const currentUserMemories = userFactSelection.items;
    const allCurrentSessionContext = scenarioHostMode
      ? []
      : deps.contextStore?.listSessionFacts?.(input.sessionId) ?? [];
    const sessionFactSelection = selectFixedPromptFacts(allCurrentSessionContext, deps.config.context.retrieval.maxFixedSessionFacts, {
      queryText: memoryQueryText
    });
    const currentSessionContext = sessionFactSelection.items;
    const semanticRetrievalSkippedReason = resolvePromptMemoryRetrievalSkippedReason({
      scenarioHostMode,
      assistantMode,
      userId: input.currentUser?.userId,
      serviceAvailable: Boolean(deps.contextRetrievalService?.retrieveUserContext)
    });
    const retrievedUserContext = semanticRetrievalSkippedReason
      ? []
      : await deps.contextRetrievalService?.retrieveUserContext({
          userId: input.currentUser!.userId,
          queryText: memoryQueryText,
          excludeItemIds: currentUserMemories.map((item) => item.id),
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        }) ?? [];
    deps.contextRetrievalService?.recordPromptMemoryReport?.({
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.currentUser?.userId ? { userId: input.currentUser.userId } : {}),
      queryText: memoryQueryText,
      currentUserMemories,
      availableUserFactCount: userFactSelection.totalCount,
      userFactLimit: userFactSelection.limit,
      currentSessionContext,
      availableSessionFactCount: sessionFactSelection.totalCount,
      sessionFactLimit: sessionFactSelection.limit,
      retrievedUserContext,
      semanticRetrievalAttempted: !semanticRetrievalSkippedReason,
      ...(semanticRetrievalSkippedReason ? { semanticRetrievalSkippedReason } : {})
    });
    logPromptMemorySuppressions(deps, {
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      persona: input.persona,
      userProfile: userProfilePromptState,
      globalRules,
      toolsetRules,
      currentUserMemories
    });

    const replayMessages = await projectReplayMessages(deps, {
      sessionId: input.sessionId,
      source: "scheduled_prompt_replay",
      replayMessages: annotateReplayMessagesWithDerivedContext(
        input.replayMessages,
        mediaContext.captionMap,
        mediaContext.audioTranscriptionMap
      ),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    const rawPromptMessages = buildScheduledTaskPrompt({
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      interactionMode: input.interactionMode,
      visibleToolNames: input.visibleToolNames,
      activeToolsets: input.activeToolsets,
      lateSystemMessages: input.lateSystemMessages,
      replayMessages,
      trigger: scheduledTrigger,
      ...(input.inlineBatchMessage ? { inlineBatchMessage: input.inlineBatchMessage } : {}),
      persona: input.persona,
      relationship: input.relationship,
      npcProfiles: assistantMode ? [] : buildNpcPromptProfiles(deps, relevantUserIds),
      participantProfiles: assistantMode ? [] : input.participantProfiles,
      userProfile: assistantMode
        ? buildAssistantUserProfilePromptState(
            input.currentUser,
            input.targetContext.chatType === "private" ? input.targetContext.senderName : undefined
          )
        : userProfilePromptState,
      currentSessionContext,
      currentUserMemories,
      retrievedUserContext,
      globalRules,
      historySummary: input.historySummary,
      debugMarkers: input.debugMarkers,
      liveResources,
      toolsetRules,
      ...(scenarioState ? { scenarioStateLines: buildScenarioStateLines(scenarioState) } : {}),
      ...(input.modeProfile ? { modeProfile: input.modeProfile } : {}),
      recentMessages: mediaContext.historyForPrompt,
      targetContext: input.targetContext
    });
    const promptMessages = await projectPromptMessageAtIndex(deps, {
      sessionId: input.sessionId,
      source: "scheduled_prompt_trigger",
      messages: rawPromptMessages,
      index: rawPromptMessages.length - 1,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });

    return {
      promptMessages,
      debugSnapshot: {
        sessionId: input.sessionId,
        systemMessages: extractSystemMessages(promptMessages),
        visibleToolNames: input.visibleToolNames,
        activeToolsets: input.activeToolsets,
        historySummary: input.historySummary,
        recentHistory: mediaContext.historyForPrompt,
        currentBatch: [],
        liveResources,
        debugMarkers: input.debugMarkers ?? [],
        toolTranscript: input.internalTranscript,
        persona: input.persona,
        globalRules,
        toolsetRules,
        currentUser: assistantMode ? null : input.currentUser,
        participantProfiles: assistantMode ? [] : input.participantProfiles,
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
    phase: "setup" | "config";
    historyForPrompt: GenerationPromptHistoryMessage[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    currentUser: StoredUser;
    participantProfiles: GenerationPromptParticipantProfile[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
    contentSafetyAlreadyProjected?: boolean;
  }) => {
    const mainProfile = getPrimaryModelProfile(deps.config, getModelRefsForRole(deps.config, "main_small"));
    const safetyProjected = await projectPromptContentSafety(deps, {
      sessionId: input.sessionId,
      source: "setup_prompt",
      historyForPrompt: input.historyForPrompt,
      batchMessages: input.batchMessages,
      contentSafetyAlreadyProjected: input.contentSafetyAlreadyProjected,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    const mediaContext = await preparePromptMediaContext(deps, {
      historyForPrompt: safetyProjected.historyForPrompt,
      batchMessages: safetyProjected.batchMessages,
      ...(input.replayMessages ? { replayMessages: input.replayMessages } : {}),
      reason: "setup_prompt",
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });

    const rawPreparedBatchMessages = await preparePromptBatchMessages(
      deps,
      safetyProjected.batchMessages,
      mediaContext.captionMap,
      {
        supportsAudioInput: mainProfile?.supportsAudioInput,
        supportsVision: mainProfile?.supportsVision,
        shouldTranscribeAudio: !mainProfile?.supportsAudioInput,
        visibleToolNames: [],
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }
    );
    const preparedBatchMessages = await projectPreparedBatchDerivedText(deps, {
      sessionId: input.sessionId,
      source: "setup_prompt_derived_text",
      batchMessages: rawPreparedBatchMessages,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    const replayMessages = await projectReplayMessages(deps, {
      sessionId: input.sessionId,
      source: "setup_prompt_replay",
      replayMessages: annotateReplayMessagesWithDerivedContext(
        input.replayMessages,
        mediaContext.captionMap,
        mediaContext.audioTranscriptionMap
      ),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });

    const promptMessages = buildSetupPrompt({
      sessionId: input.sessionId,
      interactionMode: input.interactionMode,
      lateSystemMessages: input.lateSystemMessages,
      replayMessages,
      includeBatchMediaCaptions: !mainProfile?.supportsVision,
      persona: input.persona,
      phase: input.phase,
      missingFields: deps.setupStore.describeMissingFields(input.persona).map((item) => item.key),
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
        activeToolsets: [],
        historySummary: null,
        recentHistory: mediaContext.historyForPrompt,
        currentBatch: safetyProjected.batchMessages,
        liveResources: [],
        debugMarkers: input.debugMarkers ?? [],
        toolTranscript: input.internalTranscript,
        persona: input.persona,
        globalRules: [],
        toolsetRules: [],
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

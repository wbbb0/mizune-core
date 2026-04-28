import {
  annotateHistoryMessagesWithCaptions,
  buildPromptImageCaptions,
  collectReferencedImageIds
} from "#images/imagePromptContext.ts";
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
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import type { ToolsetRuleEntry } from "#llm/prompt/toolsetRuleStore.ts";
import { isNearDuplicateText } from "#memory/similarity.ts";
import type { UserMemoryEntry } from "#memory/userMemoryEntry.ts";
import type { ScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
import { createEmptyScenarioProfile, getMissingScenarioProfileFields } from "#modes/scenarioHost/profileSchema.ts";
import { preparePromptMemoryContext } from "#llm/prompts/chat-system.prompt.ts";
import type { PromptInput } from "#llm/prompt/promptTypes.ts";

type PersonaState = Awaited<ReturnType<PersonaStore["get"]>>;
type StoredUser = Awaited<ReturnType<UserStore["getByUserId"]>>;
const LIVE_RESOURCE_TOOL_NAMES = new Set([
  "list_live_resources",
  "open_page",
  "inspect_page",
  "interact_with_page",
  "close_page",
  "terminal_list",
  "terminal_run",
  "terminal_start",
  "terminal_read",
  "terminal_write",
  "terminal_key",
  "terminal_signal",
  "terminal_stop"
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
  timezone?: string;
  occupation?: string;
  profileSummary?: string;
  relationshipNote?: string;
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
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
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
  const imageIds = Array.from(new Set([...historyImageIds, ...batchImageIds]));
  const fallbackCaptionMap = await deps.mediaCaptionService.ensureReady(
    imageIds,
    {
      reason: input.reason,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    }
  );
  const captionMap = await readImageCaptionMapFromDerivedObservations(deps, imageIds, fallbackCaptionMap);

  return {
    historyForPrompt: annotateHistoryMessagesWithCaptions(input.historyForPrompt, captionMap, { includeIds: true }),
    captionMap
  };
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
    abortSignal?: AbortSignal | undefined;
  }
) {
  return Promise.all(messages.map(async (message) => {
    const audioIds = message.audioIds ?? [];
    const attachments = dedupeResolvedChatAttachments(message.attachments ?? []);
    const imageFileIds = collectVisualAttachmentFileIds(attachments, "image");
    const emojiFileIds = collectVisualAttachmentFileIds(attachments, "emoji");
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
      forwardIds: message.forwardIds,
      replyMessageId: message.replyMessageId,
      mentionUserIds: message.mentionUserIds,
      mentionedAll: message.mentionedAll,
      mentionedSelf: message.isAtMentioned,
      timestampMs: message.receivedAt
    };
  }));
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
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
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
          playerUserId: input.currentUser?.userId ?? input.batchMessages[input.batchMessages.length - 1]?.userId ?? "unknown_user",
          playerDisplayName: input.currentUser?.preferredAddress
            ?? input.batchMessages[input.batchMessages.length - 1]?.senderName
            ?? input.currentUser?.userId
            ?? "玩家"
        })
      : null;
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
    const userProfilePromptState = assistantMode
      ? buildAssistantUserProfilePromptState(
          input.currentUser,
          input.batchMessages[input.batchMessages.length - 1]?.senderName
        )
      : buildUserProfilePromptState(
          input.currentUser,
          input.batchMessages[input.batchMessages.length - 1]?.senderName
        );
    logPromptMemorySuppressions(deps, {
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      persona: input.persona,
      userProfile: userProfilePromptState,
      globalRules,
      toolsetRules,
      currentUserMemories: (scenarioHostMode || assistantMode) ? [] : (input.currentUser?.memories ?? [])
    });

    const promptMessages = buildPrompt({
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      interactionMode: input.interactionMode,
      visibleToolNames: input.visibleToolNames,
      activeToolsets: input.activeToolsets,
      lateSystemMessages: input.lateSystemMessages,
      replayMessages: input.replayMessages,
      persona: input.persona,
      relationship: input.relationship,
      npcProfiles: assistantMode ? [] : buildNpcPromptProfiles(deps, relevantUserIds),
      participantProfiles: assistantMode ? [] : input.participantProfiles,
      userProfile: assistantMode
        ? buildAssistantUserProfilePromptState(
            input.currentUser,
            input.batchMessages[input.batchMessages.length - 1]?.senderName
          )
        : userProfilePromptState,
      currentUserMemories: (scenarioHostMode || assistantMode) ? [] : (input.currentUser?.memories ?? []),
      globalRules,
      historySummary: input.historySummary,
      recentToolEvents: input.recentToolEvents,
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
        currentBatch: input.batchMessages,
        liveResources,
        recentToolEvents: input.recentToolEvents,
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
    modeProfile?: PromptInput["modeProfile"];
  }) => {
    const scenarioHostMode = isScenarioHostMode(input.modeId);
    const assistantMode = isAssistantMode(input.modeId);
    const [mediaContext, liveResources, globalRules, toolsetRuleEntries] = await Promise.all([
      preparePromptMediaContext(deps, {
        historyForPrompt: input.historyForPrompt,
        reason: "scheduled_prompt",
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }),
      shouldIncludeLiveResources(input.visibleToolNames)
        ? collectPromptLiveResources(deps)
        : Promise.resolve([]),
      (scenarioHostMode || assistantMode) ? Promise.resolve([]) : deps.globalRuleStore.getAll(),
      (scenarioHostMode || assistantMode) ? Promise.resolve([]) : deps.toolsetRuleStore.getAll()
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
    logPromptMemorySuppressions(deps, {
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      persona: input.persona,
      userProfile: userProfilePromptState,
      globalRules,
      toolsetRules,
      currentUserMemories: (scenarioHostMode || assistantMode) ? [] : (input.currentUser?.memories ?? [])
    });

    const promptMessages = buildScheduledTaskPrompt({
      sessionId: input.sessionId,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      interactionMode: input.interactionMode,
      visibleToolNames: input.visibleToolNames,
      activeToolsets: input.activeToolsets,
      lateSystemMessages: input.lateSystemMessages,
      replayMessages: input.replayMessages,
      trigger: input.trigger,
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
      currentUserMemories: (scenarioHostMode || assistantMode) ? [] : (input.currentUser?.memories ?? []),
      globalRules,
      historySummary: input.historySummary,
      recentToolEvents: input.recentToolEvents,
      debugMarkers: input.debugMarkers,
      liveResources,
      toolsetRules,
      ...(scenarioState ? { scenarioStateLines: buildScenarioStateLines(scenarioState) } : {}),
      ...(input.modeProfile ? { modeProfile: input.modeProfile } : {}),
      recentMessages: mediaContext.historyForPrompt,
      targetContext: input.targetContext
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
        recentToolEvents: input.recentToolEvents,
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
    recentToolEvents: GenerationPromptToolEvent[];
    debugMarkers?: SessionDebugMarker[];
    internalTranscript: InternalTranscriptItem[];
    currentUser: StoredUser;
    participantProfiles: GenerationPromptParticipantProfile[];
    lastLlmUsage: SessionUsageSnapshot | null;
    batchMessages: GenerationPromptBatchMessage[];
    abortSignal?: AbortSignal;
  }) => {
    const mainProfile = getPrimaryModelProfile(deps.config, getModelRefsForRole(deps.config, "main_small"));
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
      phase: input.phase,
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
        activeToolsets: [],
        historySummary: null,
        recentHistory: mediaContext.historyForPrompt,
        currentBatch: input.batchMessages,
        liveResources: [],
        recentToolEvents: input.recentToolEvents,
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

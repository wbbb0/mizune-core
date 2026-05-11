import { buildCloseTag, escapeUserText } from "#utils/structuredEnvelope.ts";
import {
  formatStructuredEmojiReference,
  formatStructuredForwardReference,
  formatStructuredImageReference,
  formatStructuredMentionAllReference,
  formatStructuredMentionReference,
  formatStructuredMentionSelfReference,
  formatStructuredAssetFile,
  formatStructuredMessageFile,
  formatStructuredReplyReference,
  formatStructuredSpecialSegment,
  formatStructuredCount
} from "#conversation/session/historyContext.ts";
import type { LlmContentPart } from "#llm/llmClient.ts";
import {
  formatBatchItemMessageHeader,
  formatBatchMessageHeader,
  formatDraftBatchItemMessageHeader,
  formatDraftBatchMessageHeader
} from "#llm/shared/messageHeaderFormat.ts";
import type { PromptBatchMessage } from "#llm/prompt/promptTypes.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import type { AssetHandle } from "#llm/tools/core/fileHandle.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import {
  formatScenarioHostParsedUserInput,
  parseScenarioHostUserInput
} from "#modes/scenarioHost/promptInputProtocol.ts";
import { formatPromptTimestamp } from "./history-message.prompt.ts";
import { escapePromptBodyText } from "./prompt-escaping.ts";

const MAX_BATCH_ASSET_HANDLES = 6;
const MAX_ASSET_HANDLE_FIELD_CHARS = 160;
const MAX_ASSET_HANDLE_ARGS_CHARS = 220;

type PromptBatchRenderContext = {
  sessionId?: string;
  modeId?: string;
  currentTriggerUserId?: string;
  currentTriggerSenderName?: string;
};

export function buildUserBatchContent(
  input: PromptBatchMessage[],
  context?: PromptBatchRenderContext,
  includeMediaCaptions: boolean = true
): LlmContentPart[] {
  return buildBatchContentParts(formatUserBatchText(input, context, includeMediaCaptions), input);
}

export function buildProfileDraftBatchContent(
  input: PromptBatchMessage[],
  context?: PromptBatchRenderContext,
  includeMediaCaptions: boolean = true
): LlmContentPart[] {
  return buildBatchContentParts(formatProfileDraftBatchText(input, context, includeMediaCaptions), input);
}

function formatUserBatchText(
  input: PromptBatchMessage[],
  context?: PromptBatchRenderContext,
  includeMediaCaptions: boolean = true
): string {
  const lastMessage = input[input.length - 1];
  const triggerUserId = context?.currentTriggerUserId ?? lastMessage?.userId;
  const header = formatBatchHeader(input, context);
  const renderedMessages = input.map((message, index) => {
    const isCurrentTriggerUser = triggerUserId != null && message.userId === triggerUserId;
    return [
      formatBatchItemMessageHeader({
        index: index + 1,
        speakerLabel: `${message.senderName} (${message.userId})`,
        isTriggerUser: isCurrentTriggerUser,
        timestampLabel: formatPromptTimestamp(message.timestampMs)
      }),
      buildMessageBodyText(message, context, includeMediaCaptions),
      buildCloseTag("trigger_message")
    ].join("\n");
  }).join("\n\n");

  return [header, "当前会话模式说明：先按每条消息头区分发言者，再决定是否主要回应当前触发用户，或顺带处理其他人的相关信息。", "", renderedMessages, buildCloseTag("trigger_batch")].join("\n");
}

function formatProfileDraftBatchText(
  input: PromptBatchMessage[],
  context?: PromptBatchRenderContext,
  includeMediaCaptions: boolean = true
): string {
  const header = formatProfileDraftBatchHeader(input, context);
  const renderedMessages = input.map((message, index) => {
    return [
      formatDraftBatchItemMessageHeader({
        index: index + 1,
        speakerLabel: `${message.senderName} (${message.userId})`,
        timestampLabel: formatPromptTimestamp(message.timestampMs)
      }),
      buildMessageBodyText(message, context, includeMediaCaptions, { disableScenarioHostParsing: true }),
      buildCloseTag("draft_message")
    ].join("\n");
  }).join("\n\n");

  return [
    header,
    "以下消息属于当前 bot 设定草稿的配置输入。默认把 owner 的表述理解为对 bot 当前草稿的描述、修改或补充，不要当成 owner 自身资料。",
    "只有当 owner 明确要求修改用户资料、用户记忆或其他长期信息时，才把内容切换到那些目标；否则继续围绕当前草稿工作。",
    "",
    renderedMessages,
    buildCloseTag("draft_batch")
  ].join("\n");
}

function formatBatchTargetLabel(sessionId?: string): { mode: "private" | "group" | "unknown"; targetLabel: string } {
  if (!sessionId) {
    return {
      mode: "unknown",
      targetLabel: "未知"
    };
  }
  const parsed = parseChatSessionIdentity(sessionId);
  if (parsed?.kind === "group") {
    return {
      mode: "group",
      targetLabel: `群聊 ${parsed.groupId || "unknown"}`
    };
  }
  if (parsed?.kind === "private") {
    return {
      mode: "private",
      targetLabel: `私聊 ${parsed.userId || "unknown"}`
    };
  }
  return {
    mode: "unknown",
    targetLabel: sessionId
  };
}

function formatBatchHeader(input: PromptBatchMessage[], context?: PromptBatchRenderContext): string {
  const { mode, targetLabel } = formatBatchTargetLabel(context?.sessionId);
  const lastMessage = input[input.length - 1];
  const triggerUserId = context?.currentTriggerUserId ?? lastMessage?.userId;
  const triggerSenderName = context?.currentTriggerSenderName ?? lastMessage?.senderName;
  const speakerCount = new Set(input.map((message) => message.userId)).size;

  return formatBatchMessageHeader({
      sessionLabel: targetLabel,
      triggerLabel: `${triggerSenderName ?? "未知"} (${triggerUserId ?? "未知"})`,
      messageCount: input.length,
      speakerCount
    }) + `\n当前会话模式：${mode === "group" ? "群聊" : mode === "private" ? "私聊" : "未知"}。`;
}

function formatProfileDraftBatchHeader(input: PromptBatchMessage[], context?: PromptBatchRenderContext): string {
  const { mode, targetLabel } = formatBatchTargetLabel(context?.sessionId);
  const speakerCount = new Set(input.map((message) => message.userId)).size;

  return formatDraftBatchMessageHeader({
    sessionLabel: targetLabel,
    messageCount: input.length,
    speakerCount
  }) + `\n当前会话模式：${mode === "group" ? "群聊" : mode === "private" ? "私聊" : "未知"}。`;
}

function buildBatchContentParts(headerText: string, input: PromptBatchMessage[]): LlmContentPart[] {
  const parts: LlmContentPart[] = [{ type: "text", text: headerText }];
  for (const message of input) {
    const imageVisuals = new Map((message.imageVisuals ?? []).map((image) => [image.imageId, image]));
    const emojiVisuals = new Map((message.emojiVisuals ?? []).map((emoji) => [emoji.imageId, emoji]));
    const audioInputsBySource = new Map((message.audioInputs ?? []).map((audio) => [audio.source, audio]));
    const audioInputsById = new Map((message.audioIds ?? []).map((audioId, index) => {
      const source = message.audioSources[index];
      const audio = source ? audioInputsBySource.get(source) : undefined;
      return audio ? [audioId, audio] as const : null;
    }).filter((item): item is readonly [string, NonNullable<PromptBatchMessage["audioInputs"]>[number]] => item != null));
    const consumedVisualKeys = new Set<string>();
    const consumedAudioSources = new Set<string>();

    const appendImage = (fileId: string): void => {
      const image = imageVisuals.get(fileId);
      if (!image) {
        return;
      }
      consumedVisualKeys.add(`image:${fileId}`);
      parts.push({ type: "text", text: `Image ${image.imageId} attached.` });
      parts.push({ type: "image_url", image_url: { url: image.inputUrl } });
    };
    const appendEmoji = (fileId: string): void => {
      const emoji = emojiVisuals.get(fileId);
      if (!emoji) {
        return;
      }
      consumedVisualKeys.add(`emoji:${fileId}`);
      parts.push({
        type: "text",
        text: emoji.animated
          ? `Animated emoji ${emoji.imageId} attached. duration_ms=${emoji.durationMs ?? "unknown"} sampled_frames=${emoji.sampledFrameCount ?? "unknown"}`
          : `Emoji ${emoji.imageId} attached.`
      });
      parts.push({ type: "image_url", image_url: { url: emoji.inputUrl } });
    };
    const appendAudio = (audio: NonNullable<PromptBatchMessage["audioInputs"]>[number]): void => {
      if (consumedAudioSources.has(audio.source)) {
        return;
      }
      consumedAudioSources.add(audio.source);
      parts.push({ type: "text", text: `Audio attached. format=${audio.format} mime_type=${audio.mimeType}` });
      parts.push({
        type: "input_audio",
        input_audio: {
          data: audio.data,
          format: audio.format,
          mimeType: audio.mimeType
        }
      });
    };

    if ((message.contentParts?.length ?? 0) > 0) {
      for (const part of message.contentParts ?? []) {
        if (part.kind === "image" && part.fileId) {
          appendImage(part.fileId);
          continue;
        }
        if (part.kind === "emoji" && part.fileId) {
          appendEmoji(part.fileId);
          continue;
        }
        if (part.kind === "audio") {
          const audio = part.audioId
            ? audioInputsById.get(part.audioId)
            : part.source
              ? audioInputsBySource.get(part.source)
              : undefined;
          if (audio) {
            appendAudio(audio);
          }
        }
      }
    }
    for (const image of message.imageVisuals ?? []) {
      if (!consumedVisualKeys.has(`image:${image.imageId}`)) {
        appendImage(image.imageId);
      }
    }
    for (const emoji of message.emojiVisuals ?? []) {
      if (!consumedVisualKeys.has(`emoji:${emoji.imageId}`)) {
        appendEmoji(emoji.imageId);
      }
    }
    for (const audio of message.audioInputs ?? []) {
      appendAudio(audio);
    }
  }
  return parts;
}

function buildMessageBodyText(
  message: PromptBatchMessage,
  context: PromptBatchRenderContext | undefined,
  includeMediaCaptions: boolean,
  options?: {
    disableScenarioHostParsing?: boolean;
  }
): string {
  const parts: string[] = [];
  const imageCaptionById = new Map((message.imageCaptions ?? []).map((item) => [item.imageId, item.caption]));
  const emojiCaptionById = new Map((message.emojiCaptions ?? []).map((item) => [item.imageId, item.caption]));
  const audioTranscriptionById = new Map((message.audioTranscriptions ?? []).map((item) => [item.audioId, item]));
  if ((message.contentParts?.length ?? 0) > 0) {
    const content = formatMessageContentPartsForPrompt({
      contentParts: message.contentParts ?? [],
      imageCaptionById,
      emojiCaptionById,
      audioTranscriptionById,
      includeMediaCaptions,
      context,
      disableScenarioHostParsing: options?.disableScenarioHostParsing === true
    });
    const assetHandlesText = formatAssetHandlesForPrompt(message.assetHandles);
    return assetHandlesText
      ? `${content}\n附件 asset_handle：\n${assetHandlesText}`
      : content;
  }
  if (message.replyMessageId) {
    parts.push(formatStructuredReplyReference(message.replyMessageId));
  }
  if (message.mentionedSelf) {
    parts.push(formatStructuredMentionSelfReference());
  }
  if (message.mentionedAll) {
    parts.push(formatStructuredMentionAllReference());
  }
  for (const mentionUserId of message.mentionUserIds ?? []) {
    parts.push(formatStructuredMentionReference(mentionUserId));
  }
  if (message.text.trim()) {
    if (!options?.disableScenarioHostParsing && context?.modeId === "scenario_host") {
      const parsed = parseScenarioHostUserInput(message.text);
      parts.push(formatScenarioHostParsedUserInput({
        ...parsed,
        content: escapePromptBodyText(parsed.content)
      }));
    } else {
      parts.push(escapePromptBodyText(message.text.trim()));
    }
  }
  if ((message.audioSources ?? []).length > 0) {
    parts.push(formatStructuredCount("audio", message.audioSources.length));
  }
  for (const transcription of message.audioTranscriptions ?? []) {
    parts.push(formatAudioTranscriptionForPrompt(transcription));
  }
  for (const emojiId of message.emojiIds ?? []) {
    parts.push(formatStructuredEmojiReference(emojiId));
    const caption = emojiCaptionById.get(emojiId);
    if (includeMediaCaptions && caption) {
      parts.push(`表情描述：${escapePromptBodyText(caption)}`);
    }
  }
  for (const imageId of message.imageIds ?? []) {
    parts.push(formatStructuredImageReference(imageId));
    const caption = imageCaptionById.get(imageId);
    if (includeMediaCaptions && caption) {
      parts.push(`图片描述：${escapePromptBodyText(caption)}`);
    }
  }
  const assetHandlesText = formatAssetHandlesForPrompt(message.assetHandles);
  if (assetHandlesText) {
    parts.push(`附件 asset_handle：\n${assetHandlesText}`);
  }
  for (const file of message.messageFiles ?? []) {
    parts.push(formatStructuredMessageFile(file));
  }
  for (const segment of message.specialSegments ?? []) {
    parts.push(formatStructuredSpecialSegment(segment));
  }
  for (const forwardId of message.forwardIds ?? []) {
    parts.push(formatStructuredForwardReference(forwardId));
  }
  return parts.join("\n") || "<empty>";
}

function formatMessageContentPartsForPrompt(input: {
  contentParts: MessageContentPart[];
  imageCaptionById: Map<string, string>;
  emojiCaptionById: Map<string, string>;
  audioTranscriptionById: Map<string, NonNullable<PromptBatchMessage["audioTranscriptions"]>[number]>;
  includeMediaCaptions: boolean;
  context: PromptBatchRenderContext | undefined;
  disableScenarioHostParsing: boolean;
}): string {
  const parts: string[] = [];
  for (const part of input.contentParts) {
    switch (part.kind) {
      case "text":
        if (!part.text.trim()) {
          break;
        }
        if (!input.disableScenarioHostParsing && input.context?.modeId === "scenario_host") {
          const parsed = parseScenarioHostUserInput(part.text);
          parts.push(formatScenarioHostParsedUserInput({
            ...parsed,
            content: escapePromptBodyText(parsed.content)
          }));
        } else {
          parts.push(escapePromptBodyText(part.text.trim()));
        }
        break;
      case "image":
      case "emoji": {
        if (!part.fileId) {
          break;
        }
        parts.push(part.kind === "emoji"
          ? formatStructuredEmojiReference(part.fileId)
          : formatStructuredImageReference(part.fileId));
        const caption = part.kind === "emoji"
          ? input.emojiCaptionById.get(part.fileId)
          : input.imageCaptionById.get(part.fileId);
        if (input.includeMediaCaptions && caption) {
          parts.push(`${part.kind === "emoji" ? "表情" : "图片"}描述：${escapePromptBodyText(caption)}`);
        }
        break;
      }
      case "file":
        parts.push(formatStructuredMessageFile(part.file));
        break;
      case "asset_file":
        parts.push(formatStructuredAssetFile(part));
        break;
      case "mention":
        if (part.target === "self") {
          parts.push(formatStructuredMentionSelfReference());
        } else if (part.target === "all") {
          parts.push(formatStructuredMentionAllReference());
        } else if (part.userId) {
          parts.push(formatStructuredMentionReference(part.userId));
        }
        break;
      case "reply":
        parts.push(formatStructuredReplyReference(part.messageId));
        break;
      case "forward":
        parts.push(formatStructuredForwardReference(part.forwardId));
        break;
      case "audio":
        parts.push(formatStructuredCount("audio", 1));
        if (part.audioId) {
          const transcription = input.audioTranscriptionById.get(part.audioId);
          if (transcription) {
            parts.push(formatAudioTranscriptionForPrompt(transcription));
          }
        }
        break;
      case "special":
        parts.push(formatStructuredSpecialSegment({
          type: part.segmentType,
          summary: part.summary
        }));
        break;
    }
  }
  return parts.join("\n") || "<empty>";
}

function formatAudioTranscriptionForPrompt(
  transcription: NonNullable<PromptBatchMessage["audioTranscriptions"]>[number]
): string {
  if (transcription.status === "ready" && transcription.text) {
    return `音频 ${transcription.audioId} 听写：${escapePromptBodyText(transcription.text)}`;
  }
  return `音频 ${transcription.audioId} 听写失败：${escapePromptBodyText(transcription.error ?? "未配置可用听写模型或内容无法识别")}`;
}

function formatAssetHandlesForPrompt(handles: AssetHandle[] | undefined): string {
  if (!handles || handles.length === 0) {
    return "";
  }
  const rendered = handles.slice(0, MAX_BATCH_ASSET_HANDLES).map((handle) => {
    const availableTools = handle.capabilities
      .filter((item) => item.available)
      .map((item) => `${formatAssetHandleField(item.capability)}:${formatAssetHandleField(item.tool)} args=${formatAssetHandleArgs(item.args)}`)
      .join("；") || "无";
    const nextActions = handle.next_actions?.length
      ? ` next_actions=${formatAssetHandleArgs(handle.next_actions)}`
      : "";
    return [
      `- asset_ref=${formatAssetHandleField(handle.asset_ref)}`,
      `asset_id=${formatAssetHandleField(handle.asset_id)}`,
      `kind=${formatAssetHandleField(handle.kind)}`,
      `source_name=${formatAssetHandleField(handle.source_name ?? "unknown")}`,
      `可用：${availableTools}${nextActions}`
    ].join(" ");
  });
  if (handles.length > MAX_BATCH_ASSET_HANDLES) {
    rendered.push(`- 其余 ${handles.length - MAX_BATCH_ASSET_HANDLES} 个附件未展开；如需查看请先使用文件列表工具。`);
  }
  return rendered.join("\n");
}

function formatAssetHandleField(value: unknown): string {
  return compactPromptInlineText(String(value ?? ""), MAX_ASSET_HANDLE_FIELD_CHARS);
}

function formatAssetHandleArgs(value: unknown): string {
  return compactPromptInlineText(JSON.stringify(value ?? null), MAX_ASSET_HANDLE_ARGS_CHARS);
}

function compactPromptInlineText(value: string, maxChars: number): string {
  const normalized = escapeUserText(value)
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 12))}...[truncated]`;
}

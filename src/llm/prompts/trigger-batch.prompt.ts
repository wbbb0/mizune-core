import {
  formatStructuredEmojiReference,
  formatStructuredForwardReference,
  formatStructuredImageReference,
  formatStructuredMentionAllReference,
  formatStructuredMentionReference,
  formatStructuredMentionSelfReference,
  formatStructuredReplyReference,
  formatStructuredCount
} from "#conversation/session/historyContext.ts";
import type { LlmContentPart } from "#llm/llmClient.ts";
import {
  formatBatchItemMessageHeader,
  formatBatchMessageHeader
} from "#llm/shared/messageHeaderFormat.ts";
import type { PromptBatchMessage } from "#llm/prompt/promptTypes.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { formatPromptTimestamp } from "./history-message.prompt.ts";
import { escapePromptBodyText } from "./prompt-escaping.ts";

type PromptBatchRenderContext = {
  sessionId?: string;
  currentTriggerUserId?: string;
  currentTriggerSenderName?: string;
};

export function buildUserBatchContent(
  input: PromptBatchMessage[],
  context?: PromptBatchRenderContext,
  includeMediaCaptions: boolean = true
): LlmContentPart[] {
  const parts: LlmContentPart[] = [
    {
      type: "text",
      text: formatUserBatchText(input, context, includeMediaCaptions)
    }
  ];

  for (const message of input) {
    for (const image of message.imageVisuals ?? []) {
      parts.push({
        type: "text",
        text: `Image ${image.imageId} attached.`
      });
      parts.push({
        type: "image_url",
        image_url: {
          url: image.inputUrl
        }
      });
    }
    for (const emoji of message.emojiVisuals ?? []) {
      parts.push({
        type: "text",
        text: emoji.animated
          ? `Animated emoji ${emoji.imageId} attached. duration_ms=${emoji.durationMs ?? "unknown"} sampled_frames=${emoji.sampledFrameCount ?? "unknown"}`
          : `Emoji ${emoji.imageId} attached.`
      });
      parts.push({
        type: "image_url",
        image_url: {
          url: emoji.inputUrl
        }
      });
    }
    for (const audio of message.audioInputs ?? []) {
      parts.push({
        type: "text",
        text: `Audio attached. format=${audio.format} mime_type=${audio.mimeType}`
      });
      parts.push({
        type: "input_audio",
        input_audio: {
          data: audio.data,
          format: audio.format,
          mimeType: audio.mimeType
        }
      });
    }
  }

  return parts;
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
    const parts: string[] = [];
    const imageCaptionById = new Map((message.imageCaptions ?? []).map((item) => [item.imageId, item.caption]));
    const emojiCaptionById = new Map((message.emojiCaptions ?? []).map((item) => [item.imageId, item.caption]));
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
        parts.push(escapePromptBodyText(message.text.trim()));
    }
    if ((message.audioSources ?? []).length > 0) {
      parts.push(formatStructuredCount("audio", message.audioSources.length));
    }
    for (const transcription of message.audioTranscriptions ?? []) {
      if (transcription.status === "ready" && transcription.text) {
        parts.push(`音频 ${transcription.audioId} 听写：${escapePromptBodyText(transcription.text)}`);
        continue;
      }
      parts.push(`音频 ${transcription.audioId} 听写失败：${escapePromptBodyText(transcription.error ?? "未配置可用听写模型或内容无法识别")}`);
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
    for (const forwardId of message.forwardIds ?? []) {
      parts.push(formatStructuredForwardReference(forwardId));
    }
    const isCurrentTriggerUser = triggerUserId != null && message.userId === triggerUserId;
    return [
      formatBatchItemMessageHeader({
      index: index + 1,
      speakerLabel: `${message.senderName} (${message.userId})`,
      isTriggerUser: isCurrentTriggerUser,
      timestampLabel: formatPromptTimestamp(message.timestampMs)
      }),
      parts.join("\n") || "<empty>",
      "⟦/trigger_message⟧"
    ].join("\n");
  }).join("\n\n");

  return [header, "当前会话模式说明：先按每条消息头区分发言者，再决定是否主要回应当前触发用户，或顺带处理其他人的相关信息。", "", renderedMessages, "⟦/trigger_batch⟧"].join("\n");
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

import type { LlmMessage } from "#llm/llmClient.ts";
import {
  formatStructuredCount,
  formatStructuredEmojiReference,
  formatStructuredMentionAllReference,
  formatStructuredMentionReference,
  formatStructuredMentionSelfReference,
  formatStructuredReplyReference
} from "#conversation/session/historyContext.ts";
import { renderPromptSection, renderPromptSectionRaw } from "./prompt-section.ts";

export function buildReplyGatePrompt(input: {
  sessionId: string;
  chatType: "private" | "group";
  relationship: string;
  currentUserSpecialRole?: string | null;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>;
  batchMessages: Array<{
    senderName: string;
    text: string;
    images: string[];
    audioSources: string[];
    imageIds: string[];
    emojiIds: string[];
    attachments?: Array<{
      assetId: string;
      kind: string;
      semanticKind?: "image" | "emoji";
    }>;
    forwardIds: string[];
    replyMessageId: string | null;
    mentionUserIds: string[];
    mentionedAll: boolean;
    mentionedSelf: boolean;
    timestampMs?: number | null;
  }>;
  batchAnalysis: {
    summaryTags: string[];
    audioMessageCount: number;
    imageMessageCount: number;
    emojiMessageCount: number;
    forwardMessageCount: number;
    replyReferenceCount: number;
    mentionMessageCount: number;
  };
  emojiInputs: Array<{
    imageId: string;
    inputUrl: string;
    animated: boolean;
    durationMs: number | null;
    sampledFrameCount: number | null;
  }>;
}): LlmMessage[] {
  const system = [
    renderPromptSection("gate_identity", [
      "你是聊天回复门控器，负责判断当前批次消息是否应立即回复、调度大小模型及识别话题连贯性。不负责作答或内容审查。"
    ]),
    renderPromptSection("gate_rules", [
      "输出格式要求严格单行：简短理由|<动作标签>|<话题标签>",
      "理由用中文，少于20字点出直接依据。",
      "【动作标签（三选一）】",
      "- reply_small：立即回复的简单任务（日常闲聊、直接问答、轻量搜索整理）。",
      "- reply_large：立即回复的复杂任务（深度推理、多步规划、复杂事实核查）。",
      "- wait：发言明显未结束（半句话、列点断裂）。短消息、反馈、补充纠正等只要不是没说完，都不要判 wait。",
      "【话题标签（二选一）】",
      "- continue_topic：同话题延续、追问。（凡动作选 wait 者必选此项）",
      "- new_topic：明确切换到全新话题任务。",
      "【判断原则】",
      "1. 以批次末尾意图优先。只要包含明确问题、指令、强烈情绪或关键新信息，即触发 reply。",
      "2. 区分「该回」与「能答」：即使信息不足、存在敏感词、需拒答，也应选 reply 交由主模型处理，门控禁止越权拦截或因怀疑答不出而选 wait。",
      "3. 附带语音、图片、转发、引用的消息通常需要主模型识别，不可单纯因文本短而选 wait。",
      "4. 对群聊或 NPC 保持克制，只有产生实质提问/协作交互时再 reply。"
    ])
  ].filter((item): item is string => Boolean(item)).join("\n");

  const user = [
    renderPromptSection("gate_context", [
      `session_id=${input.sessionId}`,
      `chat_type=${input.chatType}`,
      `relationship=${input.relationship}`,
      `current_user_special_role=${input.currentUserSpecialRole ?? "none"}`
    ]),
    renderPromptSectionRaw("gate_recent_messages", input.recentMessages.length > 0
      ? [formatMessages(input.recentMessages)]
      : ["<empty>"]),
    renderPromptSection("gate_emoji_inputs", input.emojiInputs.length > 0
      ? [
          `count=${input.emojiInputs.length}`,
          ...input.emojiInputs.map((item) => (
            item.animated
              ? `- ${item.imageId} duration_ms=${item.durationMs ?? "unknown"} sampled_frames=${item.sampledFrameCount ?? "unknown"}`
              : `- ${item.imageId} static`
          ))
        ]
      : ["count=0"]),
    renderPromptSection("gate_batch_features", [
      `tags=${input.batchAnalysis.summaryTags.join(", ") || "none"}`,
      `audio_messages=${input.batchAnalysis.audioMessageCount}`,
      `image_messages=${input.batchAnalysis.imageMessageCount}`,
      `emoji_messages=${input.batchAnalysis.emojiMessageCount}`,
      `forward_messages=${input.batchAnalysis.forwardMessageCount}`,
      `reply_references=${input.batchAnalysis.replyReferenceCount}`,
      `mention_messages=${input.batchAnalysis.mentionMessageCount}`
    ]),
    renderPromptSectionRaw("gate_current_batch", [formatBatch(input.batchMessages)])
  ].filter((item): item is string => Boolean(item)).join("\n\n");

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: user
        },
        ...input.emojiInputs.map((item) => ({
          type: "image_url" as const,
          image_url: {
            url: item.inputUrl
          }
        }))
      ]
    }
  ];
}

function formatMessages(messages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>): string {
  return messages
    .map((message, index) => [
      `⟦gate_history_message index="${index + 1}" role="${message.role}" time="${formatTimestamp(message.timestampMs)}"⟧`,
      message.content,
      "⟦/gate_history_message⟧"
    ].join("\n"))
    .join("\n\n");
}

function formatBatch(input: Array<{
  senderName: string;
  text: string;
  images: string[];
  audioSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: Array<{
    assetId: string;
    kind: string;
    semanticKind?: "image" | "emoji";
  }>;
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  mentionedSelf: boolean;
  timestampMs?: number | null;
}>): string {
  return input
    .map((message, index) => {
      const parts: string[] = [];
      if (message.replyMessageId) {
        parts.push(formatStructuredReplyReference(message.replyMessageId));
      }
      if (message.mentionedSelf) {
        parts.push(formatStructuredMentionSelfReference());
      }
      if (message.mentionedAll) {
        parts.push(formatStructuredMentionAllReference());
      }
      for (const userId of message.mentionUserIds ?? []) {
        parts.push(formatStructuredMentionReference(userId));
      }
      if (message.text.trim()) {
        parts.push(message.text.trim());
      }
      for (const emojiId of message.emojiIds ?? []) {
        parts.push(formatStructuredEmojiReference(emojiId));
      }
      for (const attachment of message.attachments ?? []) {
        if (attachment.semanticKind === "emoji") {
          parts.push(formatStructuredEmojiReference(attachment.assetId));
        }
      }
      if (message.images.length > 0) {
        parts.push(formatStructuredCount("image_source", message.images.length));
      }
      if (message.audioSources.length > 0) {
        parts.push(formatStructuredCount("audio", message.audioSources.length));
      }
      if ((message.imageIds ?? []).length > 0) {
        parts.push(formatStructuredCount("image_id", (message.imageIds ?? []).length));
      }
      const attachmentImageCount = (message.attachments ?? []).filter((item) => (
        (item.kind === "image" || item.kind === "animated_image") && item.semanticKind !== "emoji"
      )).length;
      if (attachmentImageCount > 0) {
        parts.push(formatStructuredCount("asset_image", attachmentImageCount));
      }
      if ((message.forwardIds ?? []).length > 0) {
        parts.push(formatStructuredCount("forward", (message.forwardIds ?? []).length));
      }
      return [
        `⟦gate_batch_message index="${index + 1}" sender_name="${sanitizeAttr(message.senderName)}" time="${formatTimestamp(message.timestampMs)}"⟧`,
        parts.join("\n") || "<empty>",
        "⟦/gate_batch_message⟧"
      ].join("\n");
    })
    .join("\n\n");
}

function sanitizeAttr(value: string): string {
  return String(value)
    .replace(/"/g, "＂")
    .replace(/⟦/g, "［")
    .replace(/⟧/g, "］")
    .replace(/\r?\n/g, " ");
}

function formatTimestamp(timestampMs?: number | null): string {
  if (timestampMs == null) {
    return "unknown time";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestampMs));
}

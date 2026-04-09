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

export function buildTurnPlannerPrompt(input: {
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
      fileId: string;
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
  availableToolsets: Array<{
    id: string;
    title: string;
    description: string;
    toolNames: string[];
    plannerSignals?: string[];
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
    renderPromptSection("planner_identity", [
      "你是 turn_planner，负责判断当前批次消息是否应立即回复、选择大小模型、识别话题连贯性，并规划本轮初始工具集。你不直接回答用户问题。"
    ]),
    renderPromptSection("planner_rules", [
      "输出格式严格单行：简短理由|<动作标签>|<话题标签>|<工具集ID列表>",
      "理由用中文，少于20字，给出直接依据。",
      "动作标签（三选一）：reply_small / reply_large / wait。",
      "话题标签（二选一）：continue_topic / new_topic（若动作为 wait，话题必须是 continue_topic）。",
      "工具集ID列表：",
      "- 动作为 wait 时填 -",
      "- reply_* 时填逗号分隔 ID，例如 web_research,memory_profile；若无需工具可填 none。",
      "只可从给定 available_toolsets 中挑选，不要编造 ID。",
      "若任务可能跨多个能力域，可一次返回多个工具集；但不要无谓扩大范围。",
      "signals 只是典型意图示例，不是关键词白名单。按语义相近判定，不要求原词命中。",
      "缺失工具集比多给 1 个工具集代价更高；只要能预见本轮很可能至少调用一次某域工具，就应提前带上。",
      "判断原则：",
      "1. 末尾意图优先；有明确问题/指令/关键信息就应 reply。",
      "2. 区分该回与能答：即使可能拒答或信息不足，仍应 reply，由主模型处理。",
      "3. 含语音/图片/转发/引用通常应 reply，不可仅因文本短判 wait。",
      "4. 仅在明显半句话未完时判 wait。"
    ])
  ].filter((item): item is string => Boolean(item)).join("\n");

  const user = [
    renderPromptSection("planner_context", [
      `session_id=${input.sessionId}`,
      `chat_type=${input.chatType}`,
      `relationship=${input.relationship}`,
      `current_user_special_role=${input.currentUserSpecialRole ?? "none"}`
    ]),
    renderPromptSection("available_toolsets", input.availableToolsets.length > 0
      ? input.availableToolsets.map((toolset) => (
          `${toolset.id} | ${toolset.title} | ${toolset.description} | tools=${toolset.toolNames.join(",")}${toolset.plannerSignals && toolset.plannerSignals.length > 0 ? ` | signals=${toolset.plannerSignals.join("/")}` : ""}`
        ))
      : ["none"]),
    renderPromptSectionRaw("planner_recent_messages", input.recentMessages.length > 0
      ? [formatMessages(input.recentMessages)]
      : ["<empty>"]),
    renderPromptSection("planner_emoji_inputs", input.emojiInputs.length > 0
      ? [
          `count=${input.emojiInputs.length}`,
          ...input.emojiInputs.map((item) => (
            item.animated
              ? `- ${item.imageId} duration_ms=${item.durationMs ?? "unknown"} sampled_frames=${item.sampledFrameCount ?? "unknown"}`
              : `- ${item.imageId} static`
          ))
        ]
      : ["count=0"]),
    renderPromptSection("planner_batch_features", [
      `tags=${input.batchAnalysis.summaryTags.join(", ") || "none"}`,
      `audio_messages=${input.batchAnalysis.audioMessageCount}`,
      `image_messages=${input.batchAnalysis.imageMessageCount}`,
      `emoji_messages=${input.batchAnalysis.emojiMessageCount}`,
      `forward_messages=${input.batchAnalysis.forwardMessageCount}`,
      `reply_references=${input.batchAnalysis.replyReferenceCount}`,
      `mention_messages=${input.batchAnalysis.mentionMessageCount}`
    ]),
    renderPromptSectionRaw("planner_current_batch", [formatBatch(input.batchMessages)])
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
      `⟦planner_history_message index="${index + 1}" role="${message.role}" time="${formatTimestamp(message.timestampMs)}"⟧`,
      message.content,
      "⟦/planner_history_message⟧"
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
    fileId: string;
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
          parts.push(formatStructuredEmojiReference(attachment.fileId));
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
        `⟦planner_batch_message index="${index + 1}" sender_name="${sanitizeAttr(message.senderName)}" time="${formatTimestamp(message.timestampMs)}"⟧`,
        parts.join("\n") || "<empty>",
        "⟦/planner_batch_message⟧"
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

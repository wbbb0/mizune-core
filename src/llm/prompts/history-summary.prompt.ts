import type { SessionHistoryMessage } from "#conversation/session/sessionManager.ts";
import type { LlmMessage } from "#llm/llmClient.ts";
import { renderPromptSection, renderPromptSectionRaw } from "./prompt-section.ts";

export function buildHistorySummaryPrompt(input: {
  sessionId: string;
  existingSummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
}): LlmMessage[] {
  const system = [
    renderPromptSection("summary_identity", [
      "你是会话历史压缩器，负责将较早聊天记录提炼为后续模型可复用的高度浓缩上下文。不参与角色扮演。"
    ]),
    renderPromptSection("summary_rules", [
      "【筛选原则】",
      "- 必须保留：稳定设定、用户长期偏好、关系进展、明确约定、持续中的任务、未完成话题、关键时间线及具体细节（如人名、地点、数据）。",
      "- 坚决丢弃：寒暄客套、短期情绪噪音、重复确认、无信息量的接话。对于多媒体（图/音/转），仅提取其承载的长期事实，忽略媒介和提示格式。",
      "【整合逻辑】",
      "- 若存在“现有摘要”（即 summary_existing 区块），应将其承载的核心信息进一步提炼、浓缩，并与“新消息”（即 summary_source_messages 区块）中的事实深度融合、去重与更新。相比对新消息的提取，对现有摘要的继承应该更加精简、抓牢主干，严禁只是简单尾部追加。",
      "- 拒绝流水账式的复述（如“开始聊了...后来说了...”），应按主题、人物设定或待办状态进行结构化梳理。",
      "【输出规范】",
      "- 客观第三人称视角，使用干练的中文纯文本。勿模仿语气、勿标注轮次、勿直接引用原句、禁止捏造。",
      "- 为保留更充足的上下文，适度放长篇幅（建议输出 8~15 句或更长），在确保高信息密度的前提下，宁可保留过多细节也不要过度删减。"
    ])
  ].filter((item): item is string => Boolean(item)).join("\n");

  const text = [
    renderPromptSection("summary_context", [
      `session_id=${input.sessionId}`,
      "请把下面这些较早消息压缩成新的较早历史摘要。"
    ]),
    renderPromptSection("summary_existing", [
      input.existingSummary ?? "<none>"
    ]),
    renderPromptSectionRaw("summary_source_messages", [
      formatMessages(input.messagesToCompress)
    ])
  ].filter((item): item is string => Boolean(item)).join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: text }
  ];
}

function formatMessages(messages: SessionHistoryMessage[]): string {
  return messages
    .map((message, index) => [
      `⟦summary_source_message index="${index + 1}" role="${message.role}" time="${formatTimestamp(message.timestampMs)}"⟧`,
      message.content,
      "⟦/summary_source_message⟧"
    ].join("\n"))
    .join("\n\n");
}

function formatTimestamp(timestampMs: number): string {
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

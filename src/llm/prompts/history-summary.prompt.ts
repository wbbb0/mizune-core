import type { SessionHistoryMessage } from "#conversation/session/sessionManager.ts";
import type { LlmMessage } from "#llm/llmClient.ts";
import { renderPromptSection, renderPromptSectionRaw } from "./prompt-section.ts";

export function buildHistorySummaryPrompt(input: {
  sessionId: string;
  existingSummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
}): LlmMessage[] {
  const system = [
    renderPromptSection(“summary_identity”, [
      “你是会话历史压缩器，负责将较早聊天记录提炼为后续模型（即”我”）可无缝延续的第一人称记忆自述。你自身不扮演任何角色，但对话中的角色扮演内容应作为重要设定完整保留。”
    ]),
    renderPromptSection(“summary_rules”, [
      “【筛选原则】”,
      “- 必须保留：稳定设定、用户长期偏好、关系进展、明确约定、持续中的任务、未完成话题、关键时间线及具体细节（如人名、地点、数据）。”,
      “- 若某项设定或偏好在对话中发生了变化，保留最终状态并注明”（已更新）”，丢弃过时版本。”,
      “- 坚决丢弃：寒暄客套、短期情绪噪音、重复确认、无信息量的接话。对于多媒体（图/音/转），仅提取其承载的长期事实，忽略媒介和提示格式。”,
      “【整合逻辑】”,
      “- 若存在”现有摘要”（即 summary_existing 区块），应将其承载的核心信息进一步提炼、浓缩，并与”新消息”（即 summary_source_messages 区块）中的事实深度融合、去重与更新。相比对新消息的提取，对现有摘要的继承应该更加精简、抓牢主干，严禁只是简单尾部追加。”,
      “- 拒绝流水账式的复述（如”开始聊了...后来说了...”），按以下结构分块梳理（无内容的块可省略）：”,
      “  · 【待履行/等待触发】：我对用户的未兑现承诺、正在等待的条件或触发指令、需维持直到被明确解除的持续性状态”,
      “  · 【用户设定与偏好】：用户的稳定设定、长期偏好、角色扮演设定等”,
      “  · 【当前任务状态】：进行中或未完成的任务”,
      “  · 【关键事实与背景】：人名、地点、数据等具体细节”,
      “【输出规范】”,
      “- 以后续模型（即”我”）的第一人称视角撰写，语感如同”我”在回顾自身记忆（”我之前答应了…””我正在等待…”），让后续模型读到时自然延续身份。”,
      “- 首行固定格式：「摘要截止：YYYY-MM-DD HH:mm」（取来源消息中最后一条的时间戳）。”,
      “- 若存在【待履行/等待触发】内容，必须紧随首行之后列出，确保后续模型第一眼可见。”,
      “- 干练的中文纯文本，勿标注轮次、勿直接引用原句、禁止捏造。为保留充足上下文，适度放长篇幅（建议 8~15 句或更长），宁可多留细节也不过度删减。”
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

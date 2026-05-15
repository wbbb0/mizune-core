import { buildOpenTag, buildCloseTag } from "#utils/structuredEnvelope.ts";
import type { SessionHistoryMessage } from "#conversation/session/sessionTypes.ts";
import { formatToolObservationForSummary, type ToolObservationSummary } from "#conversation/session/toolObservation.ts";
import type { LlmMessage } from "#llm/llmClient.ts";
import { renderPromptSection, renderPromptSectionRaw } from "./prompt-section.ts";

export function buildHistorySummaryPrompt(input: {
  sessionId: string;
  existingSummary: string | null;
  messagesToCompress: SessionHistoryMessage[];
  toolObservationsToCompress?: ToolObservationSummary[];
}): LlmMessage[] {
  const system = [
    renderPromptSection("summary_identity", [
      "你是会话历史压缩器，负责把较早聊天记录压缩为后续模型（即“我”）可直接接续的第一人称工作状态与记忆。你自身不扮演任何角色，但对话中的角色扮演内容应作为重要设定完整保留；摘要不是旁观者纪要，也不是聊天流水账。"
    ]),
    renderPromptSection("summary_rules", [
      "【筛选原则】",
      "- 必须保留：稳定设定、用户长期偏好、关系进展、明确约定、持续中的任务、未完成话题、关键时间线及具体细节（如人名、地点、数据）。",
      "- 未完成/等待触发事项必须继续保留；只有来源消息或现有摘要能明确证明其已完成、已取消、已失效或已被新约定替代，才可删除。",
      "- 对“等 X 后再做 Y”“我们先做 A，之后再搞 B”这类条件触发承诺，若 X/A 未明确完成或取消，必须保留触发条件、待办事项、相关对象和下一步动作。",
      "- 若存在工具观察摘要，必须保留与当前任务有关的文件路径、命令结果、错误原因、网页资源、已验证结论和后续可重取线索。",
      "- 若某项设定或偏好在对话中发生了变化，保留最终状态并注明“（已更新）”，丢弃过时版本。",
      "- 坚决丢弃：寒暄客套、短期情绪噪音、重复确认、无信息量的接话。对于多媒体（图/音/转），仅提取其承载的长期事实，忽略媒介和提示格式。",
      "【整合逻辑】",
      "- 若存在“现有摘要”（即 summary_existing 区块），把它视为上一版状态；将“新消息”（即 summary_source_messages 区块）和工具观察合并进去，输出更新后的最新状态。相比对新消息的提取，对现有摘要的继承应该更加精简、抓牢主干，严禁只是简单尾部追加。",
      "- 对当前任务状态，优先保留目标、已完成工作、阻塞点、正在等待的输入、下一步动作和仍需验证的结论。",
      "- 拒绝流水账式的复述（如“开始聊了...后来说了...”），按以下结构分块梳理（无内容的块可省略）：",
      "  · 【待履行/等待触发】：我对用户的未兑现承诺、正在等待的条件或触发指令、需维持直到被明确解除的持续性状态",
      "  · 【当前任务状态】：进行中或未完成的任务",
      "  · 【用户设定与偏好】：用户的稳定设定、长期偏好、角色扮演设定等",
      "  · 【关键事实与背景】：人名、地点、数据等具体细节",
      "  · 【工具/资源线索】：文件路径、命令、错误、网页、资源 ID、可重取线索等",
      "【输出规范】",
      "- 以后续模型（即“我”）的第一人称视角撰写，语感如同“我”在回顾自身记忆（“我之前答应了…”“我正在等待…”），让后续模型读到时自然延续身份；用户的要求和偏好仍写成“用户希望/用户要求”，不要改写成我自己的要求。",
      "- 首行固定格式：「摘要截止：YYYY-MM-DD HH:mm」（取来源消息中最后一条的时间戳）。",
      "- 若存在【待履行/等待触发】内容，必须紧随首行之后列出，确保后续模型第一眼可见。",
      "- 干练的中文纯文本，勿标注轮次、勿直接引用原句、禁止捏造。优先控制在 8~12 句；信息很少时更短，只有持续任务、关键设定或可重取线索较多时才适度延长。"
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
    (input.toolObservationsToCompress?.length ?? 0) > 0
      ? renderPromptSectionRaw("summary_source_tool_observations", [
          formatToolObservations(input.toolObservationsToCompress ?? [])
        ])
      : null,
    renderPromptSectionRaw("summary_source_messages", [
      formatMessages(input.messagesToCompress)
    ])
  ].filter((item): item is string => Boolean(item)).join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: text }
  ];
}

function formatToolObservations(items: ToolObservationSummary[]): string {
  return items
    .map((item, index) => [
      buildOpenTag("summary_source_tool_observation", { index: String(index + 1), time: formatTimestamp(item.timestampMs) }),
      formatToolObservationForSummary(item),
      buildCloseTag("summary_source_tool_observation")
    ].join("\n"))
    .join("\n\n");
}

function formatMessages(messages: SessionHistoryMessage[]): string {
  return messages
    .map((message, index) => [
      buildOpenTag("summary_source_message", { index: String(index + 1), role: message.role, time: formatTimestamp(message.timestampMs) }),
      message.content,
      buildCloseTag("summary_source_message")
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

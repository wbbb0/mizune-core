import {
  deduplicateEnvelopeIssues,
  type ToolCallEnvelopeIssue,
  type ToolCallRejectionCode
} from "./toolCallProtocolValidation.ts";

export function buildRejectedToolResult(input: {
  toolName: string;
  code: ToolCallRejectionCode;
  message: string;
}): string {
  return JSON.stringify({
    ok: false,
    error: input.message,
    error_code: input.code,
    tool_name: input.toolName,
    recoverable: true,
    recovery: input.code === "tool_not_available"
      ? "只能调用本次请求实际提供的工具；如缺少能力，请选择现有工具或明确说明无法完成。"
      : "请根据当前工具定义重新生成完整且合法的参数。"
  });
}

export function buildProtocolCorrectionMessage(
  issues: ToolCallEnvelopeIssue[]
): string {
  const issueLines = deduplicateEnvelopeIssues(issues)
    .slice(0, 4)
    .map((issue) => `- ${issue.message}`);
  return [
    "你上一条响应不符合当前工具调用协议，因此该响应中的任何工具都没有执行，也没有把该响应作为对用户的最终回复。",
    "检测到的问题：",
    ...issueLines,
    "请重新生成响应。只能使用本次请求实际提供的结构化工具；不要输出 DSML、XML、JSON 或其他模拟工具调用协议。缺少能力时请直接说明。"
  ].join("\n");
}

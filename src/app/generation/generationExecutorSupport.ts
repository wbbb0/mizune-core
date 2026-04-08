import type { LlmToolExecutionResult } from "#llm/llmClient.ts";
import { extractToolError } from "#llm/shared/toolArgs.ts";

export function buildGenerationFailureAssistantMessage(): string {
  return "刚刚这次回复失败了，我暂时没拿到可用结果。你可以稍后重试；如果连续出现，请检查模型配置、上游接口状态或服务日志。";
}

export function summarizeToolArgs(args: unknown): string {
  return summarizeUnknown(args, 180);
}

export function summarizeToolResult(result: string | LlmToolExecutionResult): string {
  if (typeof result === "string") {
    const error = extractToolError(result);
    return summarizeText(error ?? summarizeUnknown(tryParseJson(result), 220), 220);
  }

  const contentError = extractToolError(result.content);
  if (contentError) {
    return summarizeText(contentError, 220);
  }
  if (result.terminalResponse) {
    return "terminal response";
  }
  return summarizeText(summarizeUnknown(tryParseJson(result.content), 220), 220);
}

export function extractToolContent(result: string | LlmToolExecutionResult): string {
  return typeof result === "string" ? result : result.content;
}

export function summarizeResultText(value: string, maxLength: number): string {
  return summarizeText(value, maxLength);
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeUnknown(value: unknown, maxLength: number): string {
  if (typeof value === "string") {
    return summarizeText(value, maxLength);
  }
  try {
    return summarizeText(JSON.stringify(value), maxLength);
  } catch {
    return summarizeText(String(value), maxLength);
  }
}

function summarizeText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}...`;
}

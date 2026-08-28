import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { Persona } from "#persona/personaSchema.ts";
import type { SessionBotProfile } from "#conversation/session/sessionBotProfile.ts";
import type { SessionTaskTracker } from "#conversation/taskTracker/taskTrackerTypes.ts";
import type {
  LlmFallbackEvent,
  LlmProviderCallUsage,
  LlmToolLoopLimitCause,
  LlmUsage
} from "#llm/provider/providerTypes.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import {
  buildToolLoopCheckpointPrompt,
  type ToolLoopCheckpointObservation
} from "#llm/prompts/tool-loop-checkpoint.prompt.ts";

const MAX_MODEL_REPORT_LENGTH = 3_000;
const DSML_TOOL_PROTOCOL_REGEX = /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}/i;
const CHECKPOINT_QUESTION_REGEX = /[?？]|是否继续|要不要继续|希望我继续|请.{0,8}(确认|选择)/;
const CHECKPOINT_LIMIT_REGEX = /工具.{0,8}(调用|执行).{0,8}(上限|额度|次数)|轮次.{0,6}上限|执行额度/;
const CHECKPOINT_COMPLETION_REGEX = /(任务|工作|所有|全部).{0,8}(已经|已)?(全部)?完成|已经全部完成/;

export interface ToolLoopCheckpointReportResult {
  body: string;
  modelGenerated: boolean;
  usage: LlmUsage | null;
  providerCallUsages: LlmProviderCallUsage[];
  finalProviderCallUsage: LlmProviderCallUsage | null;
  reasoningContent: string;
  assistantMetadata?: Record<string, unknown> | undefined;
}

export async function generateToolLoopCheckpointReport(input: {
  config: AppConfig;
  llmClient: LlmClient;
  logger: Logger;
  sessionId: string;
  modeId: string;
  originalRequest: string;
  taskTracker: SessionTaskTracker;
  observations: ToolLoopCheckpointObservation[];
  persona: Persona;
  sessionBotProfile: SessionBotProfile | null;
  cause: LlmToolLoopLimitCause;
  abortSignal: AbortSignal;
  assertCurrent: () => void;
  onProviderCallUsage?: (event: LlmProviderCallUsage) => Promise<void> | void;
  onFallbackEvent?: (event: LlmFallbackEvent) => Promise<void> | void;
}): Promise<ToolLoopCheckpointReportResult> {
  const deterministicBody = buildDeterministicCheckpointBody(
    input.taskTracker,
    input.observations,
    input.cause
  );
  const modelRefs = getModelRefsForRole(input.config, "summarizer");
  if (
    !input.config.llm.summarizer.enabled
    || !input.llmClient.isConfigured(modelRefs)
  ) {
    return fallbackResult(deterministicBody);
  }

  input.assertCurrent();
  try {
    const result = await input.llmClient.generate({
      modelRefOverride: modelRefs,
      timeoutMsOverride: input.config.llm.summarizer.timeoutMs,
      enableThinkingOverride: input.config.llm.summarizer.enableThinking,
      skipDebugDump: true,
      tools: [],
      abortSignal: input.abortSignal,
      messages: buildToolLoopCheckpointPrompt({
        modeId: input.modeId,
        originalRequest: input.originalRequest,
        taskTracker: input.taskTracker,
        observations: input.observations,
        persona: input.persona,
        sessionBotProfile: input.sessionBotProfile,
        cause: input.cause
      }),
      ...(input.onProviderCallUsage ? { onProviderCallUsage: input.onProviderCallUsage } : {}),
      ...(input.onFallbackEvent ? { onFallbackEvent: input.onFallbackEvent } : {})
    });
    input.assertCurrent();
    const normalized = normalizeModelReport(result.text);
    const finalProviderCallUsage = [...(result.providerCallUsages ?? [])].reverse()
      .find((event) => event.phase === "final_response") ?? null;
    if (!isCheckpointReportBodyAcceptable(normalized)) {
      input.logger.warn({
        sessionId: input.sessionId,
        reason: !normalized
          ? "empty_report"
          : containsLeakedToolProtocol(normalized)
            ? "tool_protocol_leak"
            : "body_contract_violation"
      }, "tool_loop_checkpoint_report_rejected");
      return {
        ...fallbackResult(deterministicBody),
        usage: result.usage,
        providerCallUsages: result.providerCallUsages ?? []
      };
    }
    return {
      body: normalized,
      modelGenerated: true,
      usage: result.usage,
      providerCallUsages: result.providerCallUsages ?? [],
      finalProviderCallUsage,
      reasoningContent: result.reasoningContent,
      ...(result.assistantMetadata ? { assistantMetadata: result.assistantMetadata } : {})
    };
  } catch (error) {
    if (input.abortSignal.aborted) {
      throw error;
    }
    input.assertCurrent();
    input.logger.warn({
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error)
    }, "tool_loop_checkpoint_report_failed_fallback");
    return fallbackResult(deterministicBody);
  }
}

export function composeToolLoopCheckpointMessage(input: {
  body: string;
  liveResourceLines: string[];
  cause?: LlmToolLoopLimitCause;
}): string {
  return [
    input.body.trim(),
    input.liveResourceLines.length > 0
      ? ["当前状态：", ...input.liveResourceLines.map((line) => `- ${line}`)].join("\n")
      : null,
    input.cause === "protocol_recovery"
      ? "模型连续返回了无法直接接受的工具调用；被系统拒绝的调用都没有执行，同批通过校验的合法调用可能已经执行，具体以上方工具摘要和当前状态为准。为了避免错误操作，我先停在这里。你希望我重试当前步骤、调整方案，还是停止？"
      : "本轮可执行步骤已经达到上限，我先停在这里，避免未经确认继续操作。你希望我继续处理剩余步骤，还是调整方案或停止？"
  ].filter((item): item is string => Boolean(item?.trim())).join("\n\n");
}

export function containsLeakedToolProtocol(text: string): boolean {
  return DSML_TOOL_PROTOCOL_REGEX.test(text);
}

export function isCheckpointReportBodyAcceptable(text: string): boolean {
  return Boolean(text.trim())
    && !containsLeakedToolProtocol(text)
    && !CHECKPOINT_QUESTION_REGEX.test(text)
    && !CHECKPOINT_LIMIT_REGEX.test(text)
    && !CHECKPOINT_COMPLETION_REGEX.test(text);
}

function normalizeModelReport(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= MAX_MODEL_REPORT_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_MODEL_REPORT_LENGTH).trimEnd()}…`;
}

function fallbackResult(body: string): ToolLoopCheckpointReportResult {
  return {
    body,
    modelGenerated: false,
    usage: null,
    providerCallUsages: [],
    finalProviderCallUsage: null,
    reasoningContent: ""
  };
}

function buildDeterministicCheckpointBody(
  taskTracker: SessionTaskTracker,
  observations: ToolLoopCheckpointObservation[],
  cause: LlmToolLoopLimitCause
): string {
  const primary = taskTracker.primary;
  const completed = uniqueLines(primary?.done ?? []);
  const failures = uniqueLines([
    ...(primary?.blockers ?? []),
    ...observations.filter((item) => item.outcome === "failed").map((item) => item.summary)
  ]);
  const inProgress = uniqueLines(
    observations.filter((item) => item.outcome === "in_progress").map((item) => item.summary)
  );
  const observed = uniqueLines(observations.map((item) => item.summary));
  const sections = [
    completed.length > 0 ? formatSection("我这轮已经完成了：", completed) : null,
    failures.length > 0 ? formatSection("目前遇到的问题：", failures) : null,
    inProgress.length > 0 ? formatSection("仍在进行中：", inProgress) : null,
    completed.length === 0 && failures.length === 0 && inProgress.length === 0 && observed.length > 0
      ? formatSection("我这轮已经处理了：", observed)
      : null
  ].filter((item): item is string => Boolean(item));
  return sections.join("\n\n") || (cause === "protocol_recovery"
    ? "模型连续返回了无法直接接受的工具调用；被系统拒绝的调用均未执行，当前任务状态已经保留。"
    : "我已经完成了这一轮能够执行的步骤，相关操作记录和结果都已保留。");
}

function formatSection(title: string, lines: string[]): string {
  return [title, ...lines.slice(-8).map((line) => `- ${line}`)].join("\n");
}

function uniqueLines(lines: string[]): string[] {
  return Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)));
}

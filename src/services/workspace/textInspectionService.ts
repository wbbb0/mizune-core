import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import { parseJsonObjectFromText } from "#llm/shared/jsonObjectExtraction.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { normalizeModelRefs } from "#llm/shared/modelProfiles.ts";
import { mapWithConcurrency } from "#utils/async.ts";

export type TextInspectionStatus =
  | "answered"
  | "not_found"
  | "uncertain"
  | "unstructured"
  | "error";

export type TextInspectionParseStatus = "parsed" | "repaired" | "fallback_text";

export interface PreparedTextInspectionChunk {
  chunkId: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface TextInspectionResultItem {
  chunkId: string;
  startLine: number;
  endLine: number;
  status: TextInspectionStatus;
  found: boolean | null;
  answer: string;
  evidence: string[];
  confidenceNotes: string[];
  rawAnswer: string;
  parseStatus: TextInspectionParseStatus;
  schemaIssues: string[];
  modelRef: string;
}

export interface TextInspectionResult {
  ok: boolean;
  requestedCount: number;
  results: TextInspectionResultItem[];
}

const VALID_STRUCTURED_STATUSES = new Set<TextInspectionStatus>([
  "answered",
  "not_found",
  "uncertain"
]);

export function getTextInspectorModelRefs(config: AppConfig): string[] {
  const dedicatedRefs = getModelRefsForRole(config, "text_inspector");
  return dedicatedRefs.length > 0 ? dedicatedRefs : getModelRefsForRole(config, "summarizer");
}

export class TextInspectionService {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: Pick<LlmClient, "generate" | "isConfigured">,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    const modelRefs = this.resolveModelRefs();
    return this.config.llm.enabled
      && this.config.llm.textInspector.enabled
      && modelRefs.length > 0
      && this.llmClient.isConfigured(modelRefs);
  }

  async inspectPreparedText(input: {
    question: string;
    assetRef?: string;
    chunks: PreparedTextInspectionChunk[];
    abortSignal?: AbortSignal;
  }): Promise<TextInspectionResult> {
    const question = String(input.question ?? "").trim();
    const chunks = input.chunks.filter((item) => item.chunkId && item.text.trim());
    if (!this.isEnabled()) {
      return {
        ok: false,
        requestedCount: chunks.length,
        results: chunks.map((item) => createErrorResult(item, "文本精读模型未启用或未配置。", "not_configured"))
      };
    }

    const results = await mapWithConcurrency(
      chunks,
      this.config.llm.textInspector.maxConcurrency,
      (item) => this.inspectOne(question, item, input.assetRef, input.abortSignal)
    );
    return {
      ok: results.every((item) => item.status !== "error"),
      requestedCount: chunks.length,
      results
    };
  }

  private async inspectOne(
    question: string,
    chunk: PreparedTextInspectionChunk,
    assetRef?: string,
    abortSignal?: AbortSignal
  ): Promise<TextInspectionResultItem> {
    const modelRefs = this.resolveModelRefs();
    try {
      const result = await this.llmClient.generate({
        modelRefOverride: modelRefs,
        timeoutMsOverride: this.config.llm.textInspector.timeoutMs,
        enableThinkingOverride: this.config.llm.textInspector.enableThinking,
        preferNativeNoThinkingChatEndpoint: true,
        skipDebugDump: true,
        ...(abortSignal ? { abortSignal } : {}),
        messages: buildTextInspectionPrompt(question, chunk, assetRef)
      });
      const rawAnswer = result.text.trim();
      const modelRef = result.usage.modelRef ?? normalizeModelRefs(modelRefs)[0] ?? "unknown";
      return normalizeInspectionResult(chunk, rawAnswer, modelRef);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ chunkId: chunk.chunkId, assetRef, error: message }, "text_inspection_failed");
      return createErrorResult(chunk, message, "model_call_failed");
    }
  }

  private resolveModelRefs(): string[] {
    return getTextInspectorModelRefs(this.config);
  }
}

function buildTextInspectionPrompt(
  question: string,
  chunk: PreparedTextInspectionChunk,
  assetRef?: string
): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是文本精读器，按用户问题读取给定文档片段中的具体信息。",
        "只根据片段回答，不要引用片段之外的背景知识。若片段没有答案，要说明没有找到，并给出最接近的相关信息。",
        "证据必须来自片段原文，尽量短，不要整段复制。",
        "只输出 JSON，不输出 Markdown、解释或推理过程。",
        "JSON 字段：status(answered|not_found|uncertain)、found(boolean|null)、answer(string)、evidence(string[])、confidenceNotes(string[])。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        assetRef ? `asset_ref: ${assetRef}` : null,
        `chunk_id: ${chunk.chunkId}`,
        `lines: ${chunk.startLine}-${chunk.endLine}`,
        `问题：${question || "请总结这个片段的关键信息。"}`,
        "片段：",
        chunk.text
      ].filter((item): item is string => Boolean(item)).join("\n")
    }
  ];
}

function normalizeInspectionResult(
  chunk: PreparedTextInspectionChunk,
  rawAnswer: string,
  modelRef: string
): TextInspectionResultItem {
  const parsed = parseJsonObjectFromText(rawAnswer);
  if (!parsed) {
    return createUnstructuredResult(chunk, rawAnswer, modelRef, ["json_parse_failed"]);
  }

  const schemaIssues: string[] = [];
  const status = normalizeStatus(parsed.value.status);
  if (!status) {
    schemaIssues.push("invalid_status");
  }
  const answer = normalizeString(parsed.value.answer);
  if (!answer) {
    schemaIssues.push("missing_answer");
  }
  const evidence = normalizeStringArray(parsed.value.evidence);
  const confidenceNotes = normalizeStringArray(parsed.value.confidenceNotes ?? parsed.value.confidence_notes);
  const found = normalizeFound(parsed.value.found, status);

  if (schemaIssues.length > 0) {
    return createUnstructuredResult(chunk, rawAnswer, modelRef, ["schema_validation_failed", ...schemaIssues]);
  }
  const normalizedStatus = status as Exclude<TextInspectionStatus, "unstructured" | "error">;

  return {
    chunkId: chunk.chunkId,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    status: normalizedStatus,
    found,
    answer,
    evidence,
    confidenceNotes,
    rawAnswer,
    parseStatus: parsed.parseStatus,
    schemaIssues: [],
    modelRef
  };
}

function normalizeStatus(value: unknown): Exclude<TextInspectionStatus, "unstructured" | "error"> | null {
  const normalized = String(value ?? "").trim();
  return VALID_STRUCTURED_STATUSES.has(normalized as TextInspectionStatus)
    ? normalized as Exclude<TextInspectionStatus, "unstructured" | "error">
    : null;
}

function normalizeFound(
  value: unknown,
  status: Exclude<TextInspectionStatus, "unstructured" | "error"> | null
): boolean | null {
  if (status === "answered") return true;
  if (status === "not_found") return false;
  if (status === "uncertain") return null;
  return typeof value === "boolean" ? value : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function createUnstructuredResult(
  chunk: PreparedTextInspectionChunk,
  rawAnswer: string,
  modelRef: string,
  schemaIssues: string[]
): TextInspectionResultItem {
  return {
    chunkId: chunk.chunkId,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    status: "unstructured",
    found: null,
    answer: "文本精读模型没有返回可校验结构化结果，以下是原始识别内容。",
    evidence: [],
    confidenceNotes: ["结果未通过结构化校验，不能当作确定事实。"],
    rawAnswer,
    parseStatus: "fallback_text",
    schemaIssues,
    modelRef
  };
}

function createErrorResult(
  chunk: PreparedTextInspectionChunk,
  message: string,
  issue: string
): TextInspectionResultItem {
  return {
    chunkId: chunk.chunkId,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    status: "error",
    found: null,
    answer: message,
    evidence: [],
    confidenceNotes: [],
    rawAnswer: message,
    parseStatus: "fallback_text",
    schemaIssues: [issue],
    modelRef: "unknown"
  };
}

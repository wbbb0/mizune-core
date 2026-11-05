import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmContentPart, LlmMessage } from "#llm/llmClient.ts";
import type { LlmCompletionStatus } from "#llm/provider/providerTypes.ts";
import { parseJsonObjectFromText } from "#llm/shared/jsonObjectExtraction.ts";
import { normalizeModelRefs } from "#llm/shared/modelProfiles.ts";
import { resolveVisionInputModelRefsForRole } from "#llm/shared/visionModelRouting.ts";
import { mapWithConcurrency } from "#utils/async.ts";

export type MediaInspectionStatus =
  | "answered"
  | "not_found"
  | "uncertain"
  | "unstructured"
  | "error";

export type MediaInspectionParseStatus = "parsed" | "repaired" | "fallback_text";

export interface PreparedMediaInspectionInput {
  mediaId: string;
  inputUrl: string;
  kind?: string;
  animated?: boolean;
  durationMs?: number | null;
  sampledFrameCount?: number | null;
}

export interface MediaInspectionResultItem {
  mediaId: string;
  status: MediaInspectionStatus;
  found: boolean | null;
  answer: string;
  visibleContentSummary: string | null;
  nearMatches: string[];
  confidenceNotes: string[];
  rawAnswer: string;
  parseStatus: MediaInspectionParseStatus;
  schemaIssues: string[];
  modelRef: string;
  completionStatus?: LlmCompletionStatus;
}

export interface MediaInspectionResult {
  ok: boolean;
  requestedCount: number;
  results: MediaInspectionResultItem[];
}

const VALID_STRUCTURED_STATUSES = new Set<MediaInspectionStatus>([
  "answered",
  "not_found",
  "uncertain"
]);

export class MediaInspectionService {
  private readonly unsupportedVisionWarningCache = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: Pick<LlmClient, "generate" | "isConfigured">,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    const modelRefs = this.resolveModelRefs();
    return this.config.llm.enabled
      && this.config.llm.imageInspector.enabled
      && modelRefs.length > 0
      && this.llmClient.isConfigured(modelRefs);
  }

  async inspectPreparedMedia(input: {
    question: string;
    media: PreparedMediaInspectionInput[];
    abortSignal?: AbortSignal;
  }): Promise<MediaInspectionResult> {
    const question = String(input.question ?? "").trim();
    const media = input.media.filter((item) => item.mediaId && item.inputUrl);
    if (!this.isEnabled()) {
      return {
        ok: false,
        requestedCount: media.length,
        results: media.map((item) => createErrorResult(item.mediaId, "图片精读模型未启用或未配置。", "not_configured"))
      };
    }

    const results = await mapWithConcurrency(
      media,
      this.config.llm.imageInspector.maxConcurrency,
      (item) => this.inspectOne(question, item, input.abortSignal)
    );
    return {
      ok: results.every((item) => item.status !== "error"),
      requestedCount: media.length,
      results
    };
  }

  private async inspectOne(
    question: string,
    media: PreparedMediaInspectionInput,
    abortSignal?: AbortSignal
  ): Promise<MediaInspectionResultItem> {
    const modelRefs = this.resolveModelRefs();
    try {
      const result = await this.llmClient.generate({
        modelRefOverride: modelRefs,
        timeoutMsOverride: this.config.llm.imageInspector.timeoutMs,
        enableThinkingOverride: this.config.llm.imageInspector.enableThinking,
        preferNativeNoThinkingChatEndpoint: true,
        skipDebugDump: true,
        ...(abortSignal ? { abortSignal } : {}),
        // TODO: provider 层支持统一的 structured output/json_schema 后，改为原生结构化请求，再保留文本解析作为兜底。
        messages: buildInspectionPrompt(question, media)
      });
      const rawAnswer = result.text.trim();
      const modelRef = result.usage.modelRef ?? normalizeModelRefs(modelRefs)[0] ?? "unknown";
      return normalizeInspectionResult(media.mediaId, rawAnswer, modelRef, result.completionStatus);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ mediaId: media.mediaId, error: message }, "media_inspection_failed");
      return createErrorResult(media.mediaId, message, "model_call_failed");
    }
  }

  private resolveModelRefs(): string[] {
    return resolveVisionInputModelRefsForRole({
      config: this.config,
      role: "image_inspector",
      logger: this.logger,
      warningCache: this.unsupportedVisionWarningCache
    });
  }
}

function buildInspectionPrompt(question: string, media: PreparedMediaInspectionInput): LlmMessage[] {
  const userText = [
    `media_id: ${media.mediaId}`,
    media.animated
      ? `animated: true, duration_ms: ${media.durationMs ?? "未知"}, sampled_frames: ${media.sampledFrameCount ?? "未知"}`
      : "animated: false",
    `问题：${question || "请读取这张图片中的具体可见信息。"}`
  ].join("\n");

  const content: LlmContentPart[] = [
    {
      type: "text",
      text: userText
    },
    {
      type: "image_url",
      image_url: {
        url: media.inputUrl
      }
    }
  ];

  return [
    {
      role: "system",
      content: [
        "你是图片精读器，按用户问题读取单张图片里可直接看见的信息。",
        "只根据图片回答，不要脑补。若没看到目标信息，要说明没看到什么，并概括图片实际可见内容。",
        "只输出 JSON，不输出 Markdown、解释或推理过程。",
        "JSON 字段：status(answered|not_found|uncertain)、found(boolean|null)、answer(string)、visibleContentSummary(string|null)、nearMatches(string[])、confidenceNotes(string[])。"
      ].join("\n")
    },
    {
      role: "user",
      content
    }
  ];
}

function normalizeInspectionResult(
  mediaId: string,
  rawAnswer: string,
  modelRef: string,
  completionStatus?: LlmCompletionStatus
): MediaInspectionResultItem {
  const parsed = parseJsonObjectFromText(rawAnswer);
  if (!parsed) {
    return createUnstructuredResult(mediaId, rawAnswer, modelRef, ["json_parse_failed"], completionStatus);
  }

  const schemaIssues: string[] = [];
  const obj = parsed.value;
  if (!Object.hasOwn(obj, "status")) {
    schemaIssues.push("missing_status");
  }
  const status = normalizeStatus(obj.status);
  if (!status) {
    schemaIssues.push("invalid_status");
  }
  if (!Object.hasOwn(obj, "found") || (typeof obj.found !== "boolean" && obj.found !== null)) {
    schemaIssues.push("invalid_found");
  }
  if (!Object.hasOwn(obj, "answer") || typeof obj.answer !== "string") {
    schemaIssues.push("missing_answer");
  }
  const answer = normalizeString(obj.answer);
  if (!answer && !schemaIssues.includes("missing_answer")) {
    schemaIssues.push("missing_answer");
  }
  const hasVisibleContentSummary = Object.hasOwn(obj, "visibleContentSummary") || Object.hasOwn(obj, "visible_content_summary");
  const rawVisibleSummary = Object.hasOwn(obj, "visibleContentSummary")
    ? obj.visibleContentSummary
    : obj.visible_content_summary;
  if (!hasVisibleContentSummary || (typeof rawVisibleSummary !== "string" && rawVisibleSummary !== null)) {
    schemaIssues.push("invalid_visible_content_summary");
  }
  const visibleContentSummary = normalizeNullableString(rawVisibleSummary);
  if (status === "not_found" && !visibleContentSummary) {
    schemaIssues.push("not_found_missing_visible_content_summary");
  }
  const hasNearMatches = Object.hasOwn(obj, "nearMatches") || Object.hasOwn(obj, "near_matches");
  const rawNearMatches = Object.hasOwn(obj, "nearMatches") ? obj.nearMatches : obj.near_matches;
  if (!hasNearMatches || !Array.isArray(rawNearMatches) || !rawNearMatches.every((item) => typeof item === "string")) {
    schemaIssues.push("invalid_near_matches");
  }
  const nearMatches = normalizeStringArray(rawNearMatches);
  const hasConfidenceNotes = Object.hasOwn(obj, "confidenceNotes") || Object.hasOwn(obj, "confidence_notes");
  const rawConfidenceNotes = Object.hasOwn(obj, "confidenceNotes") ? obj.confidenceNotes : obj.confidence_notes;
  if (!hasConfidenceNotes || !Array.isArray(rawConfidenceNotes) || !rawConfidenceNotes.every((item) => typeof item === "string")) {
    schemaIssues.push("invalid_confidence_notes");
  }
  const confidenceNotes = normalizeStringArray(rawConfidenceNotes);
  const found = normalizeFound(obj.found, status);

  if (schemaIssues.length > 0) {
    return createUnstructuredResult(mediaId, rawAnswer, modelRef, ["schema_validation_failed", ...schemaIssues], completionStatus);
  }
  const normalizedStatus = status as Exclude<MediaInspectionStatus, "unstructured" | "error">;

  return {
    mediaId,
    status: normalizedStatus,
    found,
    answer,
    visibleContentSummary,
    nearMatches,
    confidenceNotes,
    rawAnswer,
    parseStatus: parsed.parseStatus,
    schemaIssues: [],
    modelRef,
    ...(completionStatus ? { completionStatus } : {})
  };
}

function normalizeStatus(value: unknown): Exclude<MediaInspectionStatus, "unstructured" | "error"> | null {
  const normalized = String(value ?? "").trim();
  return VALID_STRUCTURED_STATUSES.has(normalized as MediaInspectionStatus)
    ? normalized as Exclude<MediaInspectionStatus, "unstructured" | "error">
    : null;
}

function normalizeFound(
  value: unknown,
  status: Exclude<MediaInspectionStatus, "unstructured" | "error"> | null
): boolean | null {
  if (status === "answered") {
    return true;
  }
  if (status === "not_found") {
    return false;
  }
  if (status === "uncertain") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function createUnstructuredResult(
  mediaId: string,
  rawAnswer: string,
  modelRef: string,
  schemaIssues: string[],
  completionStatus?: LlmCompletionStatus
): MediaInspectionResultItem {
  return {
    mediaId,
    status: "unstructured",
    found: null,
    answer: "视觉模型没有返回可校验结构化结果，以下是原始识别内容。",
    visibleContentSummary: null,
    nearMatches: [],
    confidenceNotes: ["结果未通过结构化校验，不能当作确定事实。"],
    rawAnswer,
    parseStatus: "fallback_text",
    schemaIssues,
    modelRef,
    ...(completionStatus ? { completionStatus } : {})
  };
}

function createErrorResult(mediaId: string, message: string, issue: string): MediaInspectionResultItem {
  return {
    mediaId,
    status: "error",
    found: null,
    answer: message,
    visibleContentSummary: null,
    nearMatches: [],
    confidenceNotes: [],
    rawAnswer: message,
    parseStatus: "fallback_text",
    schemaIssues: [issue],
    modelRef: "unknown"
  };
}

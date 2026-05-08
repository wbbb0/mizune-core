import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import { parseJsonObjectFromText } from "#llm/shared/jsonObjectExtraction.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { normalizeModelRefs } from "#llm/shared/modelProfiles.ts";
import type { PreparedTextInspectionChunk } from "./textInspectionService.ts";

const MAX_SUMMARY_BRIEF_CHARS = 700;
const MAX_SUMMARY_OUTLINE_ITEM_CHARS = 180;
const MAX_SUMMARY_FACT_CHARS = 240;
const MAX_SUMMARY_LIMITATION_CHARS = 200;

export interface DocumentSummary {
  brief: string;
  outline: string[];
  key_facts: string[];
  limitations: string[];
  modelRef: string;
}

export interface DocumentSummaryResult {
  ok: boolean;
  summary: DocumentSummary;
  error?: string;
}

export class DocumentSummaryService {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: Pick<LlmClient, "generate" | "isConfigured">,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    const modelRefs = this.resolveModelRefs();
    return this.config.llm.enabled
      && this.config.llm.summarizer.enabled
      && modelRefs.length > 0
      && this.llmClient.isConfigured(modelRefs);
  }

  async summarizePreparedDocument(input: {
    assetRef: string;
    parser: string;
    characterCount: number;
    lineCount: number;
    headings: Array<{ line_number: number; text: string }>;
    chunks: PreparedTextInspectionChunk[];
    excerpt: string;
    abortSignal?: AbortSignal;
  }): Promise<DocumentSummaryResult> {
    const fallback = createFallbackSummary(input.excerpt, "unknown");
    if (!this.isEnabled()) {
      return { ok: false, summary: fallback, error: "document_summary_model_not_configured" };
    }
    const modelRefs = this.resolveModelRefs();
    try {
      const result = await this.llmClient.generate({
        modelRefOverride: modelRefs,
        timeoutMsOverride: this.config.llm.summarizer.timeoutMs,
        enableThinkingOverride: this.config.llm.summarizer.enableThinking,
        preferNativeNoThinkingChatEndpoint: true,
        skipDebugDump: true,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        messages: buildDocumentSummaryPrompt(input)
      });
      const modelRef = result.usage.modelRef ?? normalizeModelRefs(modelRefs)[0] ?? "unknown";
      return {
        ok: true,
        summary: normalizeDocumentSummary(result.text, modelRef)
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ assetRef: input.assetRef, error: message }, "document_summary_failed");
      return {
        ok: false,
        summary: createFallbackSummary(input.excerpt, "unknown"),
        error: message
      };
    }
  }

  private resolveModelRefs(): string[] {
    return getModelRefsForRole(this.config, "summarizer");
  }
}

function buildDocumentSummaryPrompt(input: {
  assetRef: string;
  parser: string;
  characterCount: number;
  lineCount: number;
  headings: Array<{ line_number: number; text: string }>;
  chunks: PreparedTextInspectionChunk[];
  excerpt: string;
}): LlmMessage[] {
  const chunks = input.chunks
    .map((chunk) => [
      `chunk_id: ${chunk.chunkId}`,
      `lines: ${chunk.startLine}-${chunk.endLine}`,
      chunk.text
    ].join("\n"))
    .join("\n\n---\n\n");
  return [
    {
      role: "system",
      content: [
        "你是文档总结器，只根据给定文档片段生成低成本结构化摘要。",
        "不要补充文档外知识。若内容不足，要在 limitations 中说明。",
        "只输出 JSON，不输出 Markdown、解释或推理过程。",
        "JSON 字段：brief(string)、outline(string[])、key_facts(string[])、limitations(string[])。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `asset_ref: ${input.assetRef}`,
        `parser: ${input.parser}`,
        `字符数: ${input.characterCount}`,
        `行数: ${input.lineCount}`,
        input.headings.length > 0
          ? `标题:\n${input.headings.map((item) => `L${item.line_number}: ${item.text}`).join("\n")}`
          : null,
        "开头摘录:",
        input.excerpt,
        "片段:",
        chunks
      ].filter((item): item is string => Boolean(item)).join("\n")
    }
  ];
}

function normalizeDocumentSummary(rawAnswer: string, modelRef: string): DocumentSummary {
  const parsed = parseJsonObjectFromText(rawAnswer);
  if (!parsed) {
    return createFallbackSummary(rawAnswer, modelRef);
  }
  return {
    brief: compactChars(normalizeString(parsed.value.brief) || normalizeString(parsed.value.summary) || "", MAX_SUMMARY_BRIEF_CHARS),
    outline: normalizeStringArray(parsed.value.outline).map((item) => compactChars(item, MAX_SUMMARY_OUTLINE_ITEM_CHARS)).slice(0, 12),
    key_facts: normalizeStringArray(parsed.value.key_facts ?? parsed.value.keyFacts).map((item) => compactChars(item, MAX_SUMMARY_FACT_CHARS)).slice(0, 12),
    limitations: normalizeStringArray(parsed.value.limitations).map((item) => compactChars(item, MAX_SUMMARY_LIMITATION_CHARS)).slice(0, 8),
    modelRef
  };
}

function createFallbackSummary(text: string, modelRef: string): DocumentSummary {
  return {
    brief: compactChars(text.trim(), MAX_SUMMARY_BRIEF_CHARS),
    outline: [],
    key_facts: [],
    limitations: ["模型摘要不可用；返回的是文档摘录降级摘要。"],
    modelRef
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(normalizeString).filter(Boolean)
    : [];
}

function compactChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

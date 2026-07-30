import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import type { ContextEmbeddingService } from "#context/contextEmbeddingService.ts";
import type { ChatFileRecord } from "#services/workspace/types.ts";
import type {
  DocumentSummary,
  DocumentSummaryScope,
  DocumentSummaryService
} from "#services/workspace/documentSummaryService.ts";
import {
  getTextInspectorModelRefs,
  type PreparedTextInspectionChunk,
  type TextInspectionResultItem
} from "#services/workspace/textInspectionService.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { buildChatFileHandleResultFromContext } from "../core/fileHandle.ts";
import {
  arrayValue,
  compactText,
  stringValue,
  type ToolObservationResource,
  type ToolResultCompactor,
  type ToolResultObservationContext,
  type ToolResultObservationPolicy
} from "../core/resultObservation.ts";
import { pickFields, projectToolResult, type JsonObject } from "../core/toolResultProjection.ts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;
const MAX_SPREADSHEET_SHEETS = 20;
const MAX_SPREADSHEET_ROWS_PER_SHEET = 2000;
const MAX_SPREADSHEET_CELLS_PER_ROW = 100;
const MAX_SPREADSHEET_CELL_CHARS = 500;
const OVERVIEW_EXCERPT_CHARS = 800;
const MAX_HEADING_COUNT = 50;
const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 120;
const MAX_READ_CHARS = 4000;
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 12;
const SEARCH_SNIPPET_CHARS = 240;
const DEFAULT_INSPECT_CHUNKS = 6;
const MAX_INSPECT_CHUNKS = 10;
const INSPECT_CHUNK_CHARS = 1200;
const INSPECT_CHUNK_LINES = 40;
const DOCUMENT_CACHE_SCHEMA_VERSION = "document_asset_cache_v2";
const DOCUMENT_PARSER_VERSION = "document_parser_v1";
const DOCUMENT_CHUNKER_VERSION = "document_chunk_v1";
const DOCUMENT_SUMMARY_PROMPT_VERSION = "document_summary_prompt_v2";
const DOCUMENT_EMBEDDING_INDEX_VERSION = "document_embedding_index_v1";
const DOCUMENT_TEXT_MANIFEST_FILE = "manifest.json";
const DOCUMENT_TEXT_FILE = "text.txt";
const DOCUMENT_CHUNKS_FILE = "chunks.jsonl";
const DOCUMENT_SUMMARY_FILE = "summary.json";
const DOCUMENT_EMBEDDINGS_FILE = "embeddings.json";
const MAX_DOCUMENT_TEXT_CACHE_ENTRIES = 32;
const MAX_EMBEDDING_CHUNKS_PER_SEARCH = 80;
const OMITTED_PREFIX = "[chunk prefix omitted]\n";
const OMITTED_SUFFIX = "\n[chunk suffix omitted]";

const WEAK_ENGLISH_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with"
]);

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml"
]);
const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".md",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const PDF_EXTENSIONS = new Set([".pdf"]);
const DOCX_EXTENSIONS = new Set([".docx"]);
const XLSX_EXTENSIONS = new Set([".xlsx"]);
const UNSUPPORTED_BINARY_EXTENSIONS = new Set([".xls"]);

type LoadedDocumentText = {
  parser: string;
  content: string;
  fingerprint?: DocumentTextFingerprint;
  cache_hit?: boolean;
  chunk_metadata?: DocumentChunkMetadata[];
  chunk_cache_hit?: boolean;
};

type DocumentTextError = {
  status: "unsupported" | "too_large" | "parse_failed" | "empty_text";
  error: string;
  reason: string;
};

type DocumentTextLoadResult = LoadedDocumentText | DocumentTextError;

type DocumentTextFingerprint = {
  cacheSchemaVersion: string;
  parserVersion: string;
  chunkerVersion: string;
  summaryPromptVersion: string;
  embeddingProfileId: string;
  fileId: string;
  fileRef: string;
  chatFilePath: string;
  sizeBytes: number;
  createdAtMs: number;
  mimeType: string;
  sourceName: string;
  absolutePath: string;
  fileStatSize: number;
  fileStatMtimeMs: number;
  sourceHash: string;
};

type PersistedDocumentTextManifest = DocumentTextFingerprint & {
  parser: string;
  contentLength: number;
  contentHash: string;
  chunkVersion: string;
  chunkCount: number;
  updatedAtMs: number;
};

type DocumentChunkMetadata = {
  chunkId: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
};

type PersistedDocumentSummary = {
  cacheSchemaVersion: string;
  summaryPromptVersion: string;
  fileId: string;
  fileRef: string;
  sourceHash: string;
  contentHash: string;
  modelRef: string;
  summary: DocumentSummary;
  updatedAtMs: number;
};

type PersistedDocumentEmbeddingIndex = {
  version: string;
  cacheProfileId: string;
  embeddingProfileId: string;
  sourceHash: string;
  parserVersion: string;
  chunkerVersion: string;
  chunks: Array<{
    chunkId: string;
    startLine: number;
    endLine: number;
    textHash: string;
    vector: number[];
  }>;
  updatedAtMs: number;
};

const documentTextCache = new Map<string, LoadedDocumentText>();
const pendingDocumentTextLoads = new Map<string, Promise<DocumentTextLoadResult>>();
const assetDocumentLocks = new Map<string, Promise<void>>();

type DocumentChunk = PreparedTextInspectionChunk & {
  indexText: string;
  startOffset: number;
  endOffset: number;
};

const isAssetDocumentToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.chatFiles.enabled;
const isAssetDocumentInspectEnabled: ToolDescriptor["isEnabled"] = (config) => {
  return config.chatFiles.enabled
    && config.llm.textInspector.enabled
    && getTextInspectorModelRefs(config).length > 0;
};

export const assetDocumentToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "asset_document_overview",
        description: "查看已登记 asset 文档的概览、可读状态、行数、预览和 Markdown 标题。不会返回全文；支持文本、Markdown、CSV、JSON、YAML、XML、PDF、DOCX、XLSX。旧 XLS 暂不解析。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isAssetDocumentToolEnabled,
    resultObservation: assetDocumentPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "asset_document_read",
        description: "按行段读取已登记 asset 文档正文。每次最多 120 行且最多 4000 字符；超出时 truncated=true。先 overview 或 search，再按需要读取小范围。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" },
            start_line: { type: "integer", minimum: 1 },
            line_count: { type: "integer", minimum: 1, maximum: MAX_READ_LINES }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isAssetDocumentToolEnabled,
    resultObservation: assetDocumentPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "asset_document_search",
        description: "在已登记 asset 文档内检索信息，默认在 embedding 可用时使用 hybrid search，不可用时自动退回关键词搜索。limit 默认 6，最多 12；需要原文时再用 asset_document_read 读取对应行段。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" },
            query: { type: "string" },
            mode: { type: "string", enum: ["hybrid", "keyword"] },
            limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isAssetDocumentToolEnabled,
    resultObservation: assetDocumentPolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "asset_document_inspect",
        description: "调用文本精读模型，按问题总结或回答已登记 asset 文档中的具体信息。工具会先选择少量相关片段再调用模型；纯文本走 textInspector，截图等视觉输入应改用图片精读工具。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string" },
            asset_id: { type: "string" },
            question: { type: "string" },
            max_chunks: { type: "integer", minimum: 1, maximum: MAX_INSPECT_CHUNKS }
          },
          required: ["question"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isAssetDocumentInspectEnabled,
    resultObservation: assetDocumentPolicy()
  }
];

export const assetDocumentToolHandlers: Record<string, ToolHandler> = {
  async asset_document_overview(_toolCall, args, context) {
    const resolved = await resolveDocumentAsset(args, context);
    if ("error" in resolved) return projectAssetDocumentToolResult("asset_document_overview", resolved);
    const text = await loadDocumentText(resolved.file, context);
    if ("error" in text) {
      return projectAssetDocumentToolResult("asset_document_overview", {
        ok: false,
        status: text.status,
        error: text.error,
        reason: text.reason,
        asset_handle: resolved.fileHandle.asset_handle
      });
    }
    const lines = splitLines(text.content);
    const chunks = getDocumentChunks(text);
    const headings = extractHeadings(lines).slice(0, MAX_HEADING_COUNT);
    const summary = text.fingerprint
      ? await loadOrCreateDocumentSummary({
          file: resolved.file,
          text,
          chunks,
          headings,
          context,
          assetRef: resolved.fileHandle.asset_handle.asset_ref
        })
      : null;
    return projectAssetDocumentToolResult("asset_document_overview", {
      ok: true,
      status: "ready",
      asset_handle: resolved.fileHandle.asset_handle,
      document: {
        parser: text.parser,
        stats: {
          character_count: text.content.length,
          line_count: lines.length,
          chunk_count: chunks.length
        },
        cache: {
          text: text.cache_hit === true,
          chunks: text.chunk_cache_hit === true,
          summary: summary?.cache_hit === true
        },
        excerpt: compactChars(text.content, OVERVIEW_EXCERPT_CHARS),
        headings,
        summary_scope: summary?.scope ?? buildDocumentSummaryScope(chunks, selectSummaryChunks(chunks)),
        ...(summary?.summary ? { summary: summary.summary } : {}),
        ...(summary?.status ? { summary_status: summary.status } : {}),
        ...(summary?.error ? { summary_error: summary.error } : {})
      }
    });
  },

  async asset_document_read(_toolCall, args, context) {
    const resolved = await resolveDocumentAsset(args, context);
    if ("error" in resolved) return projectAssetDocumentToolResult("asset_document_read", resolved);
    const text = await loadDocumentText(resolved.file, context);
    if ("error" in text) {
      return projectAssetDocumentToolResult("asset_document_read", { ok: false, status: text.status, error: text.error, reason: text.reason, asset_handle: resolved.fileHandle.asset_handle });
    }
    const lines = splitLines(text.content);
    const requestedStartLine = Math.max(1, Math.floor(getNumberArg(args, "start_line") ?? 1));
    const lineCount = clampInteger(getNumberArg(args, "line_count") ?? DEFAULT_READ_LINES, 1, MAX_READ_LINES);
    if (requestedStartLine > lines.length) {
      return projectAssetDocumentToolResult("asset_document_read", {
        ok: true,
        status: "ready",
        asset_handle: resolved.fileHandle.asset_handle,
        requested_start_line: requestedStartLine,
        start_line: requestedStartLine,
        end_line: null,
        total_lines: lines.length,
        out_of_range: true,
        truncated: false,
        content: ""
      });
    }
    const selected = lines.slice(requestedStartLine - 1, requestedStartLine - 1 + lineCount);
    const joined = selected.join("\n");
    const content = compactChars(joined, MAX_READ_CHARS);
    const endLine = selected.length > 0 ? requestedStartLine + selected.length - 1 : requestedStartLine;
    return projectAssetDocumentToolResult("asset_document_read", {
      ok: true,
      status: "ready",
      asset_handle: resolved.fileHandle.asset_handle,
      start_line: requestedStartLine,
      end_line: endLine,
      total_lines: lines.length,
      truncated: endLine < lines.length || joined.length > content.length,
      content
    });
  },

  async asset_document_search(_toolCall, args, context) {
    const query = getStringArg(args, "query");
    if (!query) return projectAssetDocumentToolResult("asset_document_search", { ok: false, error: "query is required" });
    const resolved = await resolveDocumentAsset(args, context);
    if ("error" in resolved) return projectAssetDocumentToolResult("asset_document_search", resolved);
    const text = await loadDocumentText(resolved.file, context);
    if ("error" in text) {
      return projectAssetDocumentToolResult("asset_document_search", { ok: false, status: text.status, error: text.error, reason: text.reason, asset_handle: resolved.fileHandle.asset_handle });
    }
    const limit = clampInteger(getNumberArg(args, "limit") ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const requestedMode = getStringArg(args, "mode") === "keyword" ? "keyword" : "hybrid";
    const search = await searchDocumentChunks({
      query,
      limit,
      requestedMode,
      text,
      context
    });
    return projectAssetDocumentToolResult("asset_document_search", {
      ok: true,
      status: "ready",
      asset_handle: resolved.fileHandle.asset_handle,
      query,
      search_mode: search.mode,
      ...(search.embedding_profile_id ? { embedding_profile_id: search.embedding_profile_id } : {}),
      ...(search.embedding_cache_hit !== undefined ? { embedding_cache_hit: search.embedding_cache_hit } : {}),
      matches: search.matches,
      returned: search.matches.length,
      total_matches: search.total_matches,
      truncated: search.truncated,
      ...(search.fallback_reason ? { fallback_reason: search.fallback_reason } : {})
    });
  },

  async asset_document_inspect(_toolCall, args, context) {
    const question = getStringArg(args, "question");
    if (!question) return projectAssetDocumentToolResult("asset_document_inspect", { ok: false, error: "question is required" });
    const resolved = await resolveDocumentAsset(args, context);
    if ("error" in resolved) return projectAssetDocumentToolResult("asset_document_inspect", resolved);
    const text = await loadDocumentText(resolved.file, context);
    if ("error" in text) {
      return projectAssetDocumentToolResult("asset_document_inspect", { ok: false, status: text.status, error: text.error, reason: text.reason, asset_handle: resolved.fileHandle.asset_handle });
    }
    const maxChunks = clampInteger(getNumberArg(args, "max_chunks") ?? DEFAULT_INSPECT_CHUNKS, 1, MAX_INSPECT_CHUNKS);
    const chunks = selectInspectionChunks(getDocumentChunks(text), question, maxChunks);
    const inspection = await context.textInspectionService.inspectPreparedText({
      question,
      assetRef: resolved.fileHandle.asset_handle.asset_ref,
      chunks
    });
    return projectAssetDocumentToolResult("asset_document_inspect", {
      ok: inspection.ok,
      status: inspection.ok ? "ready" : "inspection_failed",
      ...(inspection.ok ? {} : { error: "text_inspection_failed" }),
      asset_handle: resolved.fileHandle.asset_handle,
      question,
      parser: text.parser,
      cache_hit: text.cache_hit === true,
      selected_chunks: chunks.map((item) => ({
        chunk_id: item.chunkId,
        start_line: item.startLine,
        end_line: item.endLine,
        preview: compactChars(item.text, SEARCH_SNIPPET_CHARS)
      })),
      combined_answer: combineInspectionAnswers(inspection.results),
      inspection
    });
  }
};

function projectAssetDocumentToolResult(toolName: string, canonical: unknown) {
  const result = projectToolResult({
    toolName,
    canonical: canonical as unknown as JsonObject,
    projection: {
      initial: (payload) => projectAssetDocumentInitial(toolName, payload)
    }
  });
  return {
    ...result,
    toString() {
      return result.content;
    }
  };
}

function projectAssetDocumentInitial(toolName: string, payload: JsonObject): JsonObject {
  const base = pickFields(payload, [
    "ok", "status", "error", "reason", "asset_handle", "requested_start_line",
    "start_line", "end_line", "total_lines", "out_of_range", "truncated",
    "query", "search_mode", "embedding_profile_id", "embedding_cache_hit", "returned", "total_matches", "fallback_reason",
    "question", "parser", "cache_hit", "combined_answer"
  ]);
  if (toolName === "asset_document_overview") {
    const document = objectValue(payload.document);
    return {
      ...base,
      document: document
        ? {
            parser: document.parser,
            stats: document.stats,
            cache: document.cache,
            excerpt: typeof document.excerpt === "string" ? compactProjectionText(document.excerpt, 1200) : document.excerpt,
            headings: Array.isArray(document.headings) ? document.headings.slice(0, MAX_HEADING_COUNT) : document.headings,
            summary_scope: document.summary_scope,
            summary: document.summary,
            summary_status: document.summary_status,
            summary_error: document.summary_error
          } as JsonObject
        : undefined
    };
  }
  if (toolName === "asset_document_read") {
    return {
      ...base,
      content_preview: typeof payload.content === "string" ? compactProjectionText(payload.content, 1200) : undefined
    };
  }
  if (toolName === "asset_document_search") {
    return {
      ...base,
      matches: Array.isArray(payload.matches) ? payload.matches.slice(0, MAX_SEARCH_LIMIT) : undefined
    };
  }
  if (toolName === "asset_document_inspect") {
    const inspection = objectValue(payload.inspection);
    return {
      ...base,
      selected_chunks: Array.isArray(payload.selected_chunks) ? payload.selected_chunks.slice(0, MAX_INSPECT_CHUNKS) : undefined,
      inspection: inspection
        ? {
            ok: inspection.ok,
            requestedCount: inspection.requestedCount,
            requested_count: inspection.requested_count,
            results: Array.isArray(inspection.results) ? inspection.results.slice(0, MAX_INSPECT_CHUNKS) : undefined
          } as JsonObject
        : undefined
    };
  }
  return base;
}

function compactProjectionText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function assetDocumentPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx) && !ctx.parsedContent?.asset_handle) return "error_summary";
      return "asset_document_summary";
    },
    resource: assetDocumentResource,
    refetchHint(ctx) {
      const selector = ctx.resource?.id;
      if (!selector) return null;
      if (ctx.toolName === "asset_document_search") {
        const query = stringValue(ctx.args.query);
        return query
          ? `如需重新搜索该文档，请调用 asset_document_search asset_ref=${JSON.stringify(selector)} query=${JSON.stringify(query)}`
          : `如需搜索该文档，请调用 asset_document_search asset_ref=${JSON.stringify(selector)} query=...`;
      }
      if (ctx.toolName === "asset_document_inspect") {
        const question = stringValue(ctx.args.question);
        return question
          ? `如需重新精读该文档，请调用 asset_document_inspect asset_ref=${JSON.stringify(selector)} question=${JSON.stringify(question)}`
          : `如需精读该文档，请调用 asset_document_inspect asset_ref=${JSON.stringify(selector)} question=...`;
      }
      if (ctx.toolName === "asset_document_read") {
        const startLine = ctx.parsedContent?.start_line ?? ctx.parsedContent?.startLine ?? ctx.args.start_line;
        const lineCount = ctx.args.line_count;
        return [
          `如需重读该文档片段，请调用 asset_document_read asset_ref=${JSON.stringify(selector)}`,
          startLine ? `start_line=${startLine}` : null,
          lineCount ? `line_count=${lineCount}` : null
        ].filter((item): item is string => Boolean(item)).join(" ");
      }
      return `如需刷新该文档概览，请调用 asset_document_overview asset_ref=${JSON.stringify(selector)}`;
    },
    preserveRecentRawCount: 0,
    includeInHistorySummary: false,
    replaySafe: true,
    compactors: {
      asset_document_summary: compactAssetDocumentResult
    }
  };
}

function assetDocumentResource(ctx: ToolResultObservationContext): ToolObservationResource | null {
  const assetHandle = objectValue(ctx.parsedContent?.asset_handle);
  const assetRef = stringValue(assetHandle?.asset_ref ?? assetHandle?.assetRef ?? ctx.args.asset_ref);
  const assetId = stringValue(assetHandle?.asset_id ?? assetHandle?.assetId ?? ctx.args.asset_id);
  const id = assetRef ?? assetId;
  if (!id) return null;
  const startLine = ctx.parsedContent?.start_line ?? ctx.parsedContent?.startLine;
  const endLine = ctx.parsedContent?.end_line ?? ctx.parsedContent?.endLine;
  return {
    kind: "asset",
    id,
    ...(startLine && endLine ? { locator: `L${startLine}-L${endLine}` } : {}),
    ...(assetId ? { version: `asset:${assetId}` } : {})
  };
}

function compactAssetDocumentResult(ctx: Parameters<ToolResultCompactor>[0]) {
  const assetHandle = compactAssetHandleForReplay(ctx.parsedContent?.asset_handle);
  const status = stringValue(ctx.parsedContent?.status) ?? "ready";
  const document = objectValue(ctx.parsedContent?.document);
  const stats = objectValue(document?.stats);
  const cache = objectValue(document?.cache);
  const summaryScope = objectValue(document?.summary_scope ?? document?.summaryScope);
  const matches = (arrayValue(ctx.parsedContent?.matches) ?? [])
    .map(compactDocumentMatchForReplay)
    .slice(0, MAX_SEARCH_LIMIT);
  const content = stringValue(ctx.parsedContent?.content);
  const inspection = objectValue(ctx.parsedContent?.inspection);
  const inspectionResults = (arrayValue(inspection?.results) ?? [])
    .map(compactInspectionResultForReplay)
    .slice(0, MAX_INSPECT_CHUNKS);
  const summary = [
    `${ctx.toolName} 返回文档 ${ctx.resource?.id ?? assetHandle?.assetRef ?? assetHandle?.assetId ?? ""}`,
    `status=${status}`,
    content ? `正文片段=${compactText(content, 220)}` : null,
    document?.excerpt ? `摘录=${compactText(String(document.excerpt), 220)}` : null,
    summaryScope ? `摘要范围=${summaryScope.mode ?? "unknown"} ${summaryScope.sampledChunks ?? "?"}/${summaryScope.totalChunks ?? "?"} chunks` : null,
    matches.length > 0 ? `命中 ${matches.length} 条` : null,
    inspectionResults.length > 0 ? `精读片段 ${inspectionResults.length} 个` : null
  ].filter((item): item is string => Boolean(item)).join("；");
  return replayJson(ctx, summary, {
    status,
    assetHandle,
    document: document
      ? {
          parser: document.parser ?? null,
          stats: {
            characterCount: stats?.character_count ?? stats?.characterCount ?? document.character_count ?? document.characterCount ?? null,
            lineCount: stats?.line_count ?? stats?.lineCount ?? document.line_count ?? document.lineCount ?? null,
            chunkCount: stats?.chunk_count ?? stats?.chunkCount ?? document.chunk_count ?? document.chunkCount ?? null
          },
          cache: {
            text: cache?.text ?? document.cache_hit ?? document.cacheHit ?? false,
            chunks: cache?.chunks ?? document.chunk_cache_hit ?? document.chunkCacheHit ?? false,
            summary: cache?.summary ?? document.summary_cache_hit ?? document.summaryCacheHit ?? false
          },
          summaryScope: summaryScope ? compactDocumentSummaryScopeForReplay(summaryScope) : null,
          summary: compactDocumentSummaryForReplay(document.summary),
          summaryStatus: document.summary_status ?? document.summaryStatus ?? null,
          excerpt: document.excerpt ? compactText(String(document.excerpt), OVERVIEW_EXCERPT_CHARS) : null,
          headings: arrayValue(document.headings)?.slice(0, MAX_HEADING_COUNT) ?? []
        }
      : null,
    read: content != null
      ? {
          startLine: ctx.parsedContent?.start_line ?? null,
          endLine: ctx.parsedContent?.end_line ?? null,
          totalLines: ctx.parsedContent?.total_lines ?? null,
          outOfRange: ctx.parsedContent?.out_of_range ?? false,
          truncated: ctx.parsedContent?.truncated ?? false,
          snippet: compactText(content, SEARCH_SNIPPET_CHARS)
        }
      : null,
    search: matches.length > 0 || ctx.toolName === "asset_document_search"
      ? {
          query: ctx.parsedContent?.query ?? ctx.args.query ?? null,
          mode: ctx.parsedContent?.search_mode ?? ctx.parsedContent?.searchMode ?? null,
          embeddingProfileId: ctx.parsedContent?.embedding_profile_id ?? ctx.parsedContent?.embeddingProfileId ?? null,
          matches,
          returned: ctx.parsedContent?.returned ?? matches.length,
          totalMatches: ctx.parsedContent?.total_matches ?? null,
          truncated: ctx.parsedContent?.truncated ?? false
        }
      : null,
    inspect: inspectionResults.length > 0 || ctx.toolName === "asset_document_inspect"
      ? {
          question: ctx.parsedContent?.question ?? ctx.args.question ?? null,
          combinedAnswer: ctx.parsedContent?.combined_answer ?? null,
          selectedChunks: arrayValue(ctx.parsedContent?.selected_chunks)?.slice(0, MAX_INSPECT_CHUNKS) ?? [],
          cacheHit: ctx.parsedContent?.cache_hit ?? false,
          requestedCount: inspection?.requestedCount ?? inspection?.requested_count ?? null,
          results: inspectionResults
        }
      : null,
    error: ctx.parsedContent?.error ?? null,
    reason: ctx.parsedContent?.reason ?? null
  });
}

async function resolveDocumentAsset(
  args: unknown,
  context: Parameters<ToolHandler>[2]
): Promise<
  | { file: ChatFileRecord; fileHandle: ReturnType<typeof buildChatFileHandleResultFromContext> }
  | { ok: false; error: string }
> {
  const selector = getStringArg(args, "asset_ref") || getStringArg(args, "asset_id");
  if (!selector) return { ok: false, error: "asset_ref or asset_id is required" };
  const file = await resolveChatFile(context, selector);
  if (!file) return { ok: false, error: `unknown asset: ${selector}` };
  if (file.kind !== "file") return { ok: false, error: `asset is not a document file: ${selector}` };
  return {
    file,
    fileHandle: buildChatFileHandleResultFromContext(file, context)
  };
}

async function resolveChatFile(
  context: Parameters<ToolHandler>[2],
  selector: string
): Promise<ChatFileRecord | null> {
  const direct = await context.chatFileStore.getFile(selector).catch(() => null);
  if (direct) return direct;
  const normalized = selector.trim().toLowerCase();
  return (await context.chatFileStore.listFiles())
    .find((item) => [
      item.fileRef,
      item.fileId,
      item.sourceName,
      item.chatFilePath
    ].some((value) => value.toLowerCase() === normalized)) ?? null;
}

async function loadDocumentText(
  file: ChatFileRecord,
  context: Parameters<ToolHandler>[2]
): Promise<DocumentTextLoadResult> {
  const absolutePathResult = await resolveAssetAbsolutePath(file, context);
  if ("error" in absolutePathResult) return absolutePathResult;
  const absolutePath = absolutePathResult.absolutePath;
  const statResult = await statAssetFile(absolutePath);
  if ("error" in statResult) return statResult;
  const fingerprint = await buildDocumentTextFingerprint(file, absolutePath, statResult, context);
  const cacheKey = buildDocumentTextCacheKey(fingerprint);
  const cached = getCachedDocumentText(cacheKey);
  if (cached) {
    return markDocumentTextCacheHit(cached);
  }
  const pending = pendingDocumentTextLoads.get(cacheKey);
  if (pending) {
    const result = await pending;
    return "error" in result ? result : markDocumentTextCacheHit(result);
  }
  const pendingLoad = loadDocumentTextWithPersistentCache(file, absolutePath, fingerprint, context)
    .then((result) => {
      if (!("error" in result)) {
        rememberDocumentText(cacheKey, result);
      }
      return result;
    })
    .finally(() => {
      pendingDocumentTextLoads.delete(cacheKey);
    });
  pendingDocumentTextLoads.set(cacheKey, pendingLoad);
  return pendingLoad;
}

async function loadDocumentTextWithPersistentCache(
  file: ChatFileRecord,
  absolutePath: string,
  fingerprint: DocumentTextFingerprint,
  context: Parameters<ToolHandler>[2]
): Promise<DocumentTextLoadResult> {
  return withAssetDocumentLock(file.fileId, async () => {
    const persisted = await readPersistedDocumentText(file.fileId, fingerprint, context);
    if (persisted) {
      return markDocumentTextCacheHit(persisted);
    }
    const result = await loadDocumentTextUncached(file, absolutePath, {
      size: fingerprint.fileStatSize,
      mtimeMs: fingerprint.fileStatMtimeMs
    });
    if (!("error" in result)) {
      if (!result.content.trim()) {
        return {
          status: "empty_text",
          error: "empty_document_text",
          reason: "文档解析成功，但没有提取到可读文本；如果是 PDF，可能是扫描件、加密文件或图片型页面。"
        };
      }
      const withChunkMetadata: LoadedDocumentText = {
        ...result,
        fingerprint,
        chunk_metadata: buildDocumentChunkMetadata(result.content)
      };
      await writePersistedDocumentText(file.fileId, fingerprint, withChunkMetadata, context);
      return withChunkMetadata;
    }
    return result;
  });
}

async function loadDocumentTextUncached(
  file: ChatFileRecord,
  absolutePath: string,
  fileStat: { size: number; mtimeMs: number }
): Promise<DocumentTextLoadResult> {
  const extension = inferExtension(file);
  const mimeType = file.mimeType.toLowerCase();
  const textLikeDocument = isTextDocument(file);
  if (PDF_EXTENSIONS.has(extension) || mimeType === "application/pdf") {
    return parsePdfDocument(absolutePath, fileStat.size);
  }
  if (DOCX_EXTENSIONS.has(extension) || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return parseDocxDocument(absolutePath, fileStat.size);
  }
  if (XLSX_EXTENSIONS.has(extension) || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return parseXlsxDocument(absolutePath, fileStat.size);
  }
  if (UNSUPPORTED_BINARY_EXTENSIONS.has(extension)) {
    return {
      status: "unsupported",
      error: "unsupported_document_parser",
      reason: "旧 XLS 二进制格式当前未启用解析器；请转换为 XLSX 后再读取。"
    };
  }
  if (mimeType === "application/vnd.ms-excel" && !textLikeDocument) {
    return {
      status: "unsupported",
      error: "unsupported_document_parser",
      reason: "旧 XLS 二进制格式当前未启用解析器；请转换为 XLSX 后再读取。"
    };
  }
  if (!textLikeDocument) {
    return {
      status: "unsupported",
      error: "unsupported_document_type",
      reason: `${mimeType || extension || "unknown"} 不是当前文档工具支持的文本类文档。`
    };
  }
  if (fileStat.size > MAX_TEXT_BYTES) {
    return {
      status: "too_large",
      error: "document_too_large",
      reason: `文档 ${fileStat.size} bytes 超过当前文本解析上限 ${MAX_TEXT_BYTES} bytes。`
    };
  }
  try {
    const buffer = await readFile(absolutePath);
    return {
      parser: "plain_text_v1",
      content: buffer.toString("utf8").replace(/\u0000/g, "")
    };
  } catch (error: unknown) {
    return parseFailed("text_parse_failed", error);
  }
}

function getCachedDocumentText(cacheKey: string): LoadedDocumentText | null {
  const cached = documentTextCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  documentTextCache.delete(cacheKey);
  documentTextCache.set(cacheKey, cached);
  return cached;
}

async function statAssetFile(
  absolutePath: string
): Promise<{ size: number; mtimeMs: number } | { status: "parse_failed"; error: string; reason: string }> {
  try {
    const fileStat = await stat(absolutePath);
    return {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs
    };
  } catch (error: unknown) {
    return parseFailed("asset_file_unavailable", error);
  }
}

async function buildDocumentTextFingerprint(
  file: ChatFileRecord,
  absolutePath: string,
  fileStat: { size: number; mtimeMs: number },
  context: Parameters<ToolHandler>[2]
): Promise<DocumentTextFingerprint> {
  return {
    cacheSchemaVersion: DOCUMENT_CACHE_SCHEMA_VERSION,
    parserVersion: DOCUMENT_PARSER_VERSION,
    chunkerVersion: DOCUMENT_CHUNKER_VERSION,
    summaryPromptVersion: DOCUMENT_SUMMARY_PROMPT_VERSION,
    embeddingProfileId: getDocumentEmbeddingProfileId(context),
    fileId: file.fileId,
    fileRef: file.fileRef,
    chatFilePath: file.chatFilePath,
    sizeBytes: file.sizeBytes,
    createdAtMs: file.createdAtMs,
    mimeType: file.mimeType,
    sourceName: file.sourceName,
    absolutePath,
    fileStatSize: fileStat.size,
    fileStatMtimeMs: fileStat.mtimeMs,
    sourceHash: await hashFile(absolutePath)
  };
}

function buildDocumentTextCacheKey(fingerprint: DocumentTextFingerprint): string {
  return [
    fingerprint.cacheSchemaVersion,
    fingerprint.parserVersion,
    fingerprint.chunkerVersion,
    fingerprint.summaryPromptVersion,
    fingerprint.embeddingProfileId,
    fingerprint.fileId,
    fingerprint.fileRef,
    fingerprint.chatFilePath,
    fingerprint.sizeBytes,
    fingerprint.createdAtMs,
    fingerprint.mimeType,
    fingerprint.sourceName,
    fingerprint.absolutePath,
    fingerprint.fileStatSize,
    fingerprint.fileStatMtimeMs,
    fingerprint.sourceHash
  ].join("|");
}

function rememberDocumentText(cacheKey: string, value: LoadedDocumentText): void {
  if (documentTextCache.has(cacheKey)) {
    documentTextCache.delete(cacheKey);
  }
  documentTextCache.set(cacheKey, {
    parser: value.parser,
    content: value.content,
    ...(value.fingerprint ? { fingerprint: value.fingerprint } : {}),
    ...(value.chunk_metadata ? { chunk_metadata: value.chunk_metadata } : {}),
    ...(value.chunk_cache_hit ? { chunk_cache_hit: value.chunk_cache_hit } : {})
  });
  while (documentTextCache.size > MAX_DOCUMENT_TEXT_CACHE_ENTRIES) {
    const oldestKey = documentTextCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    documentTextCache.delete(oldestKey);
  }
}

function markDocumentTextCacheHit(value: LoadedDocumentText): LoadedDocumentText {
  return {
    parser: value.parser,
    content: value.content,
    ...(value.fingerprint ? { fingerprint: value.fingerprint } : {}),
    cache_hit: true,
    ...(value.chunk_metadata ? { chunk_metadata: value.chunk_metadata } : {}),
    ...(value.chunk_cache_hit ? { chunk_cache_hit: value.chunk_cache_hit } : {})
  };
}

async function readPersistedDocumentText(
  fileId: string,
  fingerprint: DocumentTextFingerprint,
  context: Parameters<ToolHandler>[2]
): Promise<LoadedDocumentText | null> {
  const cacheDir = resolveDocumentTextCacheDir(context, fileId);
  if (!cacheDir) return null;
  try {
    const manifestRaw = await readFile(join(cacheDir, DOCUMENT_TEXT_MANIFEST_FILE), "utf8");
    const manifest = parsePersistedDocumentTextManifest(manifestRaw);
    if (!manifest || !isSameDocumentTextFingerprint(manifest, fingerprint)) {
      return null;
    }
    const content = await readFile(join(cacheDir, DOCUMENT_TEXT_FILE), "utf8");
    if (content.length !== manifest.contentLength || hashDocumentText(content) !== manifest.contentHash) {
      return null;
    }
    const chunkCache = await readPersistedDocumentChunks(cacheDir, content, manifest);
    return {
      parser: manifest.parser,
      content,
      ...(chunkCache ?? {})
    };
  } catch {
    return null;
  }
}

async function writePersistedDocumentText(
  fileId: string,
  fingerprint: DocumentTextFingerprint,
  value: LoadedDocumentText,
  context: Parameters<ToolHandler>[2]
): Promise<void> {
  const cacheDir = resolveDocumentTextCacheDir(context, fileId);
  if (!cacheDir) return;
  let textTempPath: string | null = null;
  let chunksTempPath: string | null = null;
  let manifestTempPath: string | null = null;
  try {
    await mkdir(cacheDir, { recursive: true });
    const textPath = join(cacheDir, DOCUMENT_TEXT_FILE);
    const chunksPath = join(cacheDir, DOCUMENT_CHUNKS_FILE);
    const manifestPath = join(cacheDir, DOCUMENT_TEXT_MANIFEST_FILE);
    const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    textTempPath = join(cacheDir, `${DOCUMENT_TEXT_FILE}.${suffix}.tmp`);
    chunksTempPath = join(cacheDir, `${DOCUMENT_CHUNKS_FILE}.${suffix}.tmp`);
    manifestTempPath = join(cacheDir, `${DOCUMENT_TEXT_MANIFEST_FILE}.${suffix}.tmp`);
    const chunkMetadata = buildDocumentChunkMetadata(value.content);
    const manifest: PersistedDocumentTextManifest = {
      ...fingerprint,
      parser: value.parser,
      contentLength: value.content.length,
      contentHash: hashDocumentText(value.content),
      chunkVersion: DOCUMENT_CHUNKER_VERSION,
      chunkCount: chunkMetadata.length,
      updatedAtMs: Date.now()
    };
    await writeFile(textTempPath, value.content, "utf8");
    await writeFile(chunksTempPath, serializeDocumentChunks(chunkMetadata), "utf8");
    await writeFile(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(textTempPath, textPath);
    await rename(chunksTempPath, chunksPath);
    await rename(manifestTempPath, manifestPath);
  } catch {
    // Persistent document cache is an optimization; tool results should not fail if it is unavailable.
    await Promise.all([
      textTempPath ? rmTempFile(textTempPath) : Promise.resolve(),
      chunksTempPath ? rmTempFile(chunksTempPath) : Promise.resolve(),
      manifestTempPath ? rmTempFile(manifestTempPath) : Promise.resolve()
    ]);
  }
}

async function rmTempFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

async function readPersistedDocumentChunks(
  cacheDir: string,
  content: string,
  manifest: PersistedDocumentTextManifest
): Promise<Pick<LoadedDocumentText, "chunk_metadata" | "chunk_cache_hit"> | null> {
  if (manifest.chunkVersion !== DOCUMENT_CHUNKER_VERSION) return null;
  try {
    const raw = await readFile(join(cacheDir, DOCUMENT_CHUNKS_FILE), "utf8");
    const metadata = parseDocumentChunkMetadataLines(raw);
    return metadata.length === manifest.chunkCount && isValidDocumentChunkMetadata(metadata, content)
      ? { chunk_metadata: metadata, chunk_cache_hit: true }
      : null;
  } catch {
    return null;
  }
}

function resolveDocumentTextCacheDir(
  context: Parameters<ToolHandler>[2],
  fileId: string
): string | null {
  const store = context.chatFileStore as typeof context.chatFileStore & {
    resolveDocumentCacheDirectory?: (fileId: string) => string;
  };
  if (typeof store.resolveDocumentCacheDirectory !== "function") return null;
  try {
    return store.resolveDocumentCacheDirectory(fileId);
  } catch {
    return null;
  }
}

async function withAssetDocumentLock<T>(fileId: string, operation: () => Promise<T>): Promise<T> {
  const previous = assetDocumentLocks.get(fileId);
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  assetDocumentLocks.set(fileId, current);
  try {
    await previous?.catch(() => undefined);
    return await operation();
  } finally {
    release?.();
    if (assetDocumentLocks.get(fileId) === current) {
      assetDocumentLocks.delete(fileId);
    }
  }
}

function getDocumentSummaryService(context: Parameters<ToolHandler>[2]): DocumentSummaryService | null {
  const candidate = (context as typeof context & { documentSummaryService?: DocumentSummaryService }).documentSummaryService;
  return candidate ?? null;
}

function getContextEmbeddingService(context: Parameters<ToolHandler>[2]): Pick<ContextEmbeddingService, "isAvailable" | "getStatus" | "embedTexts"> | null {
  const candidate = (context as typeof context & { contextEmbeddingService?: Pick<ContextEmbeddingService, "isAvailable" | "getStatus" | "embedTexts"> }).contextEmbeddingService;
  return candidate ?? null;
}

function getDocumentEmbeddingProfileId(context: Parameters<ToolHandler>[2]): string {
  const embeddingService = getContextEmbeddingService(context);
  if (!embeddingService?.isAvailable()) {
    return "embedding_disabled";
  }
  const status = embeddingService.getStatus();
  return [
    "document_embedding",
    ...status.modelRefs,
    status.textPreprocessVersion,
    status.chunkerVersion
  ].map((item) => encodeURIComponent(item)).join(":");
}

function parsePersistedDocumentTextManifest(raw: string): PersistedDocumentTextManifest | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!objectValue(parsed)) return null;
    const manifest = parsed as Partial<PersistedDocumentTextManifest>;
    return typeof manifest.parser === "string"
      && typeof manifest.contentLength === "number"
      && typeof manifest.contentHash === "string"
      && typeof manifest.chunkVersion === "string"
      && typeof manifest.chunkCount === "number"
      && isDocumentTextFingerprint(manifest)
      ? manifest as PersistedDocumentTextManifest
      : null;
  } catch {
    return null;
  }
}

function hashDocumentText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

function isSameDocumentTextFingerprint(
  manifest: DocumentTextFingerprint,
  fingerprint: DocumentTextFingerprint
): boolean {
  return manifest.cacheSchemaVersion === fingerprint.cacheSchemaVersion
    && manifest.parserVersion === fingerprint.parserVersion
    && manifest.chunkerVersion === fingerprint.chunkerVersion
    && manifest.summaryPromptVersion === fingerprint.summaryPromptVersion
    && manifest.embeddingProfileId === fingerprint.embeddingProfileId
    && manifest.fileId === fingerprint.fileId
    && manifest.fileRef === fingerprint.fileRef
    && manifest.chatFilePath === fingerprint.chatFilePath
    && manifest.sizeBytes === fingerprint.sizeBytes
    && manifest.createdAtMs === fingerprint.createdAtMs
    && manifest.mimeType === fingerprint.mimeType
    && manifest.sourceName === fingerprint.sourceName
    && manifest.absolutePath === fingerprint.absolutePath
    && manifest.fileStatSize === fingerprint.fileStatSize
    && manifest.fileStatMtimeMs === fingerprint.fileStatMtimeMs
    && manifest.sourceHash === fingerprint.sourceHash;
}

function isDocumentTextFingerprint(value: Partial<PersistedDocumentTextManifest>): value is DocumentTextFingerprint {
  return typeof value.cacheSchemaVersion === "string"
    && typeof value.parserVersion === "string"
    && typeof value.chunkerVersion === "string"
    && typeof value.summaryPromptVersion === "string"
    && typeof value.embeddingProfileId === "string"
    && typeof value.fileId === "string"
    && typeof value.fileRef === "string"
    && typeof value.chatFilePath === "string"
    && typeof value.sizeBytes === "number"
    && typeof value.createdAtMs === "number"
    && typeof value.mimeType === "string"
    && typeof value.sourceName === "string"
    && typeof value.absolutePath === "string"
    && typeof value.fileStatSize === "number"
    && typeof value.fileStatMtimeMs === "number"
    && typeof value.sourceHash === "string";
}

async function resolveAssetAbsolutePath(
  file: ChatFileRecord,
  context: Parameters<ToolHandler>[2]
): Promise<{ absolutePath: string } | { status: "parse_failed"; error: string; reason: string }> {
  try {
    return { absolutePath: await context.chatFileStore.resolveAbsolutePath(file.fileId) };
  } catch (error: unknown) {
    return parseFailed("asset_file_unavailable", error);
  }
}

async function loadOrCreateDocumentSummary(input: {
  file: ChatFileRecord;
  text: LoadedDocumentText;
  chunks: DocumentChunk[];
  headings: Array<{ line_number: number; text: string }>;
  context: Parameters<ToolHandler>[2];
  assetRef: string;
}): Promise<{ status: "ready" | "not_configured" | "failed"; scope: DocumentSummaryScope; summary?: DocumentSummary; cache_hit?: boolean; error?: string } | null> {
  const fingerprint = input.text.fingerprint;
  if (!fingerprint) return null;
  const summaryChunks = selectSummaryChunks(input.chunks);
  const scope = buildDocumentSummaryScope(input.chunks, summaryChunks);
  const service = getDocumentSummaryService(input.context);
  if (!service?.isEnabled()) {
    return { status: "not_configured", scope };
  }
  return withAssetDocumentLock(input.file.fileId, async () => {
    const persisted = await readPersistedDocumentSummary(input.file.fileId, fingerprint, input.context);
    if (persisted) {
      return { status: "ready", scope, summary: persisted.summary, cache_hit: true };
    }
    try {
      const summaryResult = await service.summarizePreparedDocument({
        assetRef: input.assetRef,
        parser: input.text.parser,
        characterCount: input.text.content.length,
        lineCount: splitLines(input.text.content).length,
        headings: input.headings,
        chunks: summaryChunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text
        })),
        summaryScope: scope,
        excerpt: compactChars(input.text.content, OVERVIEW_EXCERPT_CHARS)
      });
      if (!summaryResult.ok) {
        return { status: "failed", scope, error: summaryResult.error ?? "document_summary_failed" };
      }
      await writePersistedDocumentSummary(input.file.fileId, fingerprint, summaryResult.summary, input.context);
      return { status: "ready", scope, summary: summaryResult.summary, cache_hit: false };
    } catch (error: unknown) {
      return { status: "failed", scope, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function selectSummaryChunks(chunks: DocumentChunk[]): DocumentChunk[] {
  return chunks.slice(0, DEFAULT_INSPECT_CHUNKS);
}

function buildDocumentSummaryScope(allChunks: DocumentChunk[], sampledChunks: DocumentChunk[]): DocumentSummaryScope {
  const first = sampledChunks[0];
  const last = sampledChunks[sampledChunks.length - 1];
  return {
    mode: "head_sample",
    fullDocument: sampledChunks.length === allChunks.length,
    sampledChunks: sampledChunks.length,
    totalChunks: allChunks.length,
    sampledStartLine: first?.startLine ?? null,
    sampledEndLine: last?.endLine ?? null,
    sampledCharacters: sampledChunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
  };
}

async function readPersistedDocumentSummary(
  fileId: string,
  fingerprint: DocumentTextFingerprint,
  context: Parameters<ToolHandler>[2]
): Promise<PersistedDocumentSummary | null> {
  const cacheDir = resolveDocumentTextCacheDir(context, fileId);
  if (!cacheDir) return null;
  try {
    const raw = await readFile(join(cacheDir, DOCUMENT_SUMMARY_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedDocumentSummary>;
    return parsed.cacheSchemaVersion === fingerprint.cacheSchemaVersion
      && parsed.summaryPromptVersion === fingerprint.summaryPromptVersion
      && parsed.fileId === fingerprint.fileId
      && parsed.fileRef === fingerprint.fileRef
      && parsed.sourceHash === fingerprint.sourceHash
      && parsed.contentHash === hashDocumentText((await readFile(join(cacheDir, DOCUMENT_TEXT_FILE), "utf8")))
      && objectValue(parsed.summary)
      && typeof parsed.modelRef === "string"
      ? parsed as PersistedDocumentSummary
      : null;
  } catch {
    return null;
  }
}

async function writePersistedDocumentSummary(
  fileId: string,
  fingerprint: DocumentTextFingerprint,
  summary: DocumentSummary,
  context: Parameters<ToolHandler>[2]
): Promise<void> {
  const cacheDir = resolveDocumentTextCacheDir(context, fileId);
  if (!cacheDir) return;
  const tempPath = join(cacheDir, `${DOCUMENT_SUMMARY_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await mkdir(cacheDir, { recursive: true });
    const persisted: PersistedDocumentSummary = {
      cacheSchemaVersion: fingerprint.cacheSchemaVersion,
      summaryPromptVersion: fingerprint.summaryPromptVersion,
      fileId: fingerprint.fileId,
      fileRef: fingerprint.fileRef,
      sourceHash: fingerprint.sourceHash,
      contentHash: hashDocumentText(await readFile(join(cacheDir, DOCUMENT_TEXT_FILE), "utf8")),
      modelRef: summary.modelRef,
      summary,
      updatedAtMs: Date.now()
    };
    await writeFile(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    await rename(tempPath, join(cacheDir, DOCUMENT_SUMMARY_FILE));
  } catch {
    await rmTempFile(tempPath);
  }
}

async function searchDocumentChunks(input: {
  query: string;
  limit: number;
  requestedMode: "hybrid" | "keyword";
  text: LoadedDocumentText;
  context: Parameters<ToolHandler>[2];
}): Promise<{
  mode: "keyword" | "hybrid" | "keyword_fallback";
  matches: Array<Record<string, unknown>>;
  total_matches: number;
  truncated: boolean;
  embedding_profile_id?: string;
  embedding_cache_hit?: boolean;
  fallback_reason?: string;
}> {
  const keyword = searchDocumentChunksByKeyword(input.text, input.query, input.limit);
  if (input.requestedMode === "keyword") {
    return { mode: "keyword", ...keyword };
  }
  const embeddingService = getContextEmbeddingService(input.context);
  if (!embeddingService?.isAvailable() || !input.text.fingerprint) {
    return {
      mode: "keyword_fallback",
      ...keyword,
      fallback_reason: "embedding_not_configured"
    };
  }
  try {
    const chunks = getDocumentChunks(input.text).slice(0, MAX_EMBEDDING_CHUNKS_PER_SEARCH);
    if (chunks.length === 0) {
      return { mode: "hybrid", matches: [], total_matches: 0, truncated: false, embedding_profile_id: input.text.fingerprint.embeddingProfileId };
    }
    const embeddingIndex = await loadOrCreateDocumentEmbeddingIndex({
      chunks,
      fingerprint: input.text.fingerprint,
      context: input.context,
      embeddingService
    });
    const queryEmbedding = await embeddingService.embedTexts([input.query]);
    const queryVector = queryEmbedding.vectors[0] ?? [];
    const terms = extractSearchTerms(input.query);
    const maxKeywordScore = Math.max(1, ...chunks.map((chunk) => scoreInspectionChunk(chunk.indexText, terms)));
    const ranked = chunks
      .map((chunk, index) => {
        const indexed = embeddingIndex.index.chunks[index];
        const vectorScore = indexed ? cosineSimilarity(queryVector, indexed.vector) : 0;
        const keywordScore = scoreInspectionChunk(chunk.indexText, terms) / maxKeywordScore;
        return {
          chunk,
          score: vectorScore * 0.75 + keywordScore * 0.25,
          vectorScore,
          keywordScore
        };
      })
      .filter((item) => Number.isFinite(item.score) && item.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.startLine - right.chunk.startLine);
    const selected = ranked.slice(0, input.limit);
    return {
      mode: "hybrid",
      embedding_profile_id: embeddingIndex.index.embeddingProfileId,
      embedding_cache_hit: embeddingIndex.cacheHit,
      total_matches: ranked.length,
      truncated: ranked.length > input.limit,
      matches: selected.map((item) => ({
        chunk_id: item.chunk.chunkId,
        start_line: item.chunk.startLine,
        end_line: item.chunk.endLine,
        line_number: item.chunk.startLine,
        score: Number(item.score.toFixed(4)),
        vector_score: Number(item.vectorScore.toFixed(4)),
        keyword_score: Number(item.keywordScore.toFixed(4)),
        snippet: buildHybridSearchSnippet(item.chunk.indexText, terms)
      }))
    };
  } catch (error: unknown) {
    return {
      mode: "keyword_fallback",
      ...keyword,
      fallback_reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function searchDocumentChunksByKeyword(
  text: LoadedDocumentText,
  query: string,
  limit: number
): {
  matches: Array<Record<string, unknown>>;
  total_matches: number;
  truncated: boolean;
} {
  const lowerQuery = query.toLowerCase();
  const allMatches = getDocumentChunks(text)
    .flatMap((chunk) => splitLines(chunk.indexText)
      .map((line, index) => ({
        chunk,
        line,
        line_number: chunk.startLine + index,
        char_start: line.toLowerCase().indexOf(lowerQuery)
      }))
      .filter((item) => item.char_start >= 0)
      .map((item) => ({
        ...item,
        char_end: item.char_start + query.length
      })));
  const matchedLines = allMatches.slice(0, limit + 1);
  return {
    matches: matchedLines
      .slice(0, limit)
      .map((item) => ({
        chunk_id: item.chunk.chunkId,
        start_line: item.chunk.startLine,
        end_line: item.chunk.endLine,
        line_number: item.line_number,
        char_start: item.char_start,
        char_end: item.char_end,
        snippet: buildSearchSnippet(item.line, lowerQuery)
      })),
    total_matches: allMatches.length,
    truncated: matchedLines.length > limit
  };
}

async function loadOrCreateDocumentEmbeddingIndex(input: {
  chunks: DocumentChunk[];
  fingerprint: DocumentTextFingerprint;
  context: Parameters<ToolHandler>[2];
  embeddingService: Pick<ContextEmbeddingService, "embedTexts">;
}): Promise<{ index: PersistedDocumentEmbeddingIndex; cacheHit: boolean }> {
  return withAssetDocumentLock(input.fingerprint.fileId, async () => {
    const persisted = await readPersistedDocumentEmbeddingIndex(input.fingerprint.fileId, input.fingerprint, input.chunks, input.context);
    if (persisted) return { index: persisted, cacheHit: true };
    const batch = await input.embeddingService.embedTexts(input.chunks.map((chunk) => chunk.indexText));
    const index: PersistedDocumentEmbeddingIndex = {
      version: DOCUMENT_EMBEDDING_INDEX_VERSION,
      cacheProfileId: input.fingerprint.embeddingProfileId,
      embeddingProfileId: batch.profile.profileId,
      sourceHash: input.fingerprint.sourceHash,
      parserVersion: input.fingerprint.parserVersion,
      chunkerVersion: input.fingerprint.chunkerVersion,
      chunks: input.chunks.map((chunk, index) => ({
        chunkId: chunk.chunkId,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        textHash: hashDocumentText(chunk.indexText),
        vector: batch.vectors[index] ?? []
      })),
      updatedAtMs: Date.now()
    };
    await writePersistedDocumentEmbeddingIndex(input.fingerprint.fileId, index, input.context);
    return { index, cacheHit: false };
  });
}

async function readPersistedDocumentEmbeddingIndex(
  fileId: string,
  fingerprint: DocumentTextFingerprint,
  chunks: DocumentChunk[],
  context: Parameters<ToolHandler>[2]
): Promise<PersistedDocumentEmbeddingIndex | null> {
  const cacheDir = resolveDocumentTextCacheDir(context, fileId);
  if (!cacheDir) return null;
  try {
    const parsed = JSON.parse(await readFile(join(cacheDir, DOCUMENT_EMBEDDINGS_FILE), "utf8")) as PersistedDocumentEmbeddingIndex;
    if (parsed.version !== DOCUMENT_EMBEDDING_INDEX_VERSION
      || parsed.cacheProfileId !== fingerprint.embeddingProfileId
      || parsed.sourceHash !== fingerprint.sourceHash
      || parsed.parserVersion !== fingerprint.parserVersion
      || parsed.chunkerVersion !== fingerprint.chunkerVersion
      || parsed.chunks.length !== chunks.length) {
      return null;
    }
    return parsed.chunks.every((item, index) => {
      const chunk = chunks[index];
      return chunk
        && item.chunkId === chunk.chunkId
        && item.startLine === chunk.startLine
        && item.endLine === chunk.endLine
        && item.textHash === hashDocumentText(chunk.indexText)
        && Array.isArray(item.vector)
        && item.vector.length > 0;
    }) ? parsed : null;
  } catch {
    return null;
  }
}

async function writePersistedDocumentEmbeddingIndex(
  fileId: string,
  index: PersistedDocumentEmbeddingIndex,
  context: Parameters<ToolHandler>[2]
): Promise<void> {
  const cacheDir = resolveDocumentTextCacheDir(context, fileId);
  if (!cacheDir) return;
  const tempPath = join(cacheDir, `${DOCUMENT_EMBEDDINGS_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(index)}\n`, "utf8");
    await rename(tempPath, join(cacheDir, DOCUMENT_EMBEDDINGS_FILE));
  } catch {
    await rmTempFile(tempPath);
  }
}

async function parsePdfDocument(
  absolutePath: string,
  actualSizeBytes: number
): Promise<{ parser: string; content: string } | { status: "too_large" | "parse_failed"; error: string; reason: string }> {
  const sizeError = ensureBinaryDocumentSize(actualSizeBytes);
  if (sizeError) return sizeError;
  let parser: PDFParse | null = null;
  try {
    const buffer = await readFile(absolutePath);
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return {
      parser: "pdf_parse_v2",
      content: normalizeExtractedText(result.text, MAX_EXTRACTED_TEXT_CHARS)
    };
  } catch (error: unknown) {
    return parseFailed("pdf_parse_failed", error);
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

async function parseDocxDocument(
  absolutePath: string,
  actualSizeBytes: number
): Promise<{ parser: string; content: string } | { status: "too_large" | "parse_failed"; error: string; reason: string }> {
  const sizeError = ensureBinaryDocumentSize(actualSizeBytes);
  if (sizeError) return sizeError;
  try {
    const result = await mammoth.extractRawText({ path: absolutePath });
    const warnings = result.messages
      .map((item) => item.message)
      .filter(Boolean)
      .join("\n");
    return {
      parser: "mammoth_raw_text_v1",
      content: normalizeExtractedText(warnings ? `${result.value}\n\n[parser warnings]\n${warnings}` : result.value, MAX_EXTRACTED_TEXT_CHARS)
    };
  } catch (error: unknown) {
    return parseFailed("docx_parse_failed", error);
  }
}

async function parseXlsxDocument(
  absolutePath: string,
  actualSizeBytes: number
): Promise<{ parser: string; content: string } | { status: "too_large" | "parse_failed"; error: string; reason: string }> {
  const sizeError = ensureBinaryDocumentSize(actualSizeBytes);
  if (sizeError) return sizeError;
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(absolutePath);
    const parts = workbook.worksheets.slice(0, MAX_SPREADSHEET_SHEETS).map((sheet) => {
      const rows: string[] = [];
      const rowCount = Math.min(sheet.rowCount, MAX_SPREADSHEET_ROWS_PER_SHEET);
      for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
        const row = sheet.getRow(rowIndex);
        const values = Array.isArray(row.values)
          ? row.values.slice(1, MAX_SPREADSHEET_CELLS_PER_ROW + 1)
          : [];
        rows.push(values.map(formatSpreadsheetCell).join(","));
      }
      if (sheet.rowCount > rowCount) {
        rows.push(`[truncated ${sheet.rowCount - rowCount} rows]`);
      }
      return `# Sheet: ${sheet.name}\n${rows.join("\n")}`;
    });
    if (workbook.worksheets.length > MAX_SPREADSHEET_SHEETS) {
      parts.push(`[truncated ${workbook.worksheets.length - MAX_SPREADSHEET_SHEETS} sheets]`);
    }
    return {
      parser: "exceljs_xlsx_csv_v1",
      content: normalizeExtractedText(parts.join("\n\n"), MAX_EXTRACTED_TEXT_CHARS)
    };
  } catch (error: unknown) {
    return parseFailed("xlsx_parse_failed", error);
  }
}

function formatSpreadsheetCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const richText = value as { text?: unknown; result?: unknown; formula?: unknown; hyperlink?: unknown };
    if (richText.text != null) return csvEscape(compactChars(String(richText.text), MAX_SPREADSHEET_CELL_CHARS));
    if (richText.result != null) return csvEscape(compactChars(String(richText.result), MAX_SPREADSHEET_CELL_CHARS));
    if (richText.formula != null) return csvEscape(compactChars(String(richText.formula), MAX_SPREADSHEET_CELL_CHARS));
    if (richText.hyperlink != null) return csvEscape(compactChars(String(richText.hyperlink), MAX_SPREADSHEET_CELL_CHARS));
  }
  return csvEscape(compactChars(String(value), MAX_SPREADSHEET_CELL_CHARS));
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function ensureBinaryDocumentSize(
  actualSizeBytes: number
): { status: "too_large"; error: string; reason: string } | null {
  return actualSizeBytes > MAX_BINARY_DOCUMENT_BYTES
    ? {
        status: "too_large",
        error: "document_too_large",
        reason: `文档 ${actualSizeBytes} bytes 超过当前二进制文档解析上限 ${MAX_BINARY_DOCUMENT_BYTES} bytes。`
      }
    : null;
}

function parseFailed(errorCode: string, error: unknown): { status: "parse_failed"; error: string; reason: string } {
  return {
    status: "parse_failed",
    error: errorCode,
    reason: error instanceof Error ? error.message : String(error)
  };
}

function normalizeExtractedText(value: string, maxChars: number): string {
  const normalized = value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars)}\n[parser output truncated at ${maxChars} characters]`;
}

function isTextDocument(file: ChatFileRecord): boolean {
  const mimeType = file.mimeType.toLowerCase();
  if (TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || TEXT_MIME_TYPES.has(mimeType)) {
    return true;
  }
  return TEXT_EXTENSIONS.has(inferExtension(file));
}

function inferExtension(file: ChatFileRecord): string {
  return extname(file.sourceName || file.fileRef || file.chatFilePath).toLowerCase();
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n?/g, "\n").split("\n");
}

function extractHeadings(lines: string[]): Array<{ line_number: number; text: string }> {
  return lines
    .map((line, index) => ({ line_number: index + 1, text: line.trim() }))
    .filter((item) => /^#{1,6}\s+\S/.test(item.text))
    .map((item) => ({ ...item, text: item.text.replace(/^#{1,6}\s+/, "") }));
}

function buildSearchSnippet(line: string, lowerQuery: string): string {
  const lowerLine = line.toLowerCase();
  const index = lowerLine.indexOf(lowerQuery);
  if (index < 0) return compactChars(line.trim(), SEARCH_SNIPPET_CHARS);
  const start = Math.max(0, index - Math.floor(SEARCH_SNIPPET_CHARS / 2));
  return compactChars(line.slice(start).trim(), SEARCH_SNIPPET_CHARS);
}

function buildHybridSearchSnippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const matchedIndex = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (matchedIndex == null) {
    return compactChars(text.trim(), SEARCH_SNIPPET_CHARS);
  }
  const start = Math.max(0, matchedIndex - Math.floor(SEARCH_SNIPPET_CHARS / 2));
  return compactChars(text.slice(start).trim(), SEARCH_SNIPPET_CHARS);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function getDocumentChunks(text: LoadedDocumentText): DocumentChunk[] {
  return text.chunk_metadata && isValidDocumentChunkMetadata(text.chunk_metadata, text.content)
    ? hydrateDocumentChunks(text.content, text.chunk_metadata)
    : buildDocumentChunksFromContent(text.content);
}

function buildDocumentChunkMetadata(content: string): DocumentChunkMetadata[] {
  return buildDocumentChunksFromContent(content).map((chunk) => ({
    chunkId: chunk.chunkId,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset
  }));
}

function buildDocumentChunksFromContent(content: string): DocumentChunk[] {
  const normalized = normalizeChunkContent(content);
  const lines = normalized.split("\n");
  const chunks: DocumentChunk[] = [];
  let startLine = 1;
  let current: string[] = [];
  let currentChars = 0;
  let offset = 0;
  let currentStartOffset = 0;
  let currentEndOffset = 0;
  const flush = () => {
    if (current.length === 0) return;
    const indexText = normalized.slice(currentStartOffset, currentEndOffset);
    chunks.push({
      chunkId: `chunk_${chunks.length + 1}`,
      startLine,
      endLine: startLine + current.length - 1,
      text: compactChars(indexText, INSPECT_CHUNK_CHARS),
      indexText,
      startOffset: currentStartOffset,
      endOffset: currentEndOffset
    });
    startLine += current.length;
    current = [];
    currentChars = 0;
  };

  for (const line of lines) {
    const lineChars = line.length + 1;
    if (current.length >= INSPECT_CHUNK_LINES || (current.length > 0 && currentChars + lineChars > INSPECT_CHUNK_CHARS)) {
      flush();
    }
    if (current.length === 0) {
      currentStartOffset = offset;
    }
    current.push(line);
    currentEndOffset = offset + line.length;
    currentChars += lineChars;
    offset += lineChars;
  }
  flush();
  return chunks;
}

function hydrateDocumentChunks(content: string, metadata: DocumentChunkMetadata[]): DocumentChunk[] {
  const normalized = normalizeChunkContent(content);
  return metadata.map((chunk) => {
    const indexText = normalized.slice(chunk.startOffset, chunk.endOffset);
    return {
      chunkId: chunk.chunkId,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      text: compactChars(indexText, INSPECT_CHUNK_CHARS),
      indexText
    };
  });
}

function normalizeChunkContent(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function serializeDocumentChunks(metadata: DocumentChunkMetadata[]): string {
  return metadata.map((chunk) => JSON.stringify(chunk)).join("\n") + (metadata.length > 0 ? "\n" : "");
}

function parseDocumentChunkMetadataLines(raw: string): DocumentChunkMetadata[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;
      if (!objectValue(parsed)) throw new Error("invalid document chunk metadata");
      return parsed as Partial<DocumentChunkMetadata>;
    })
    .filter(isDocumentChunkMetadata);
}

function isDocumentChunkMetadata(value: Partial<DocumentChunkMetadata>): value is DocumentChunkMetadata {
  return typeof value.chunkId === "string"
    && Number.isInteger(value.startLine)
    && Number.isInteger(value.endLine)
    && Number.isInteger(value.startOffset)
    && Number.isInteger(value.endOffset);
}

function isValidDocumentChunkMetadata(metadata: DocumentChunkMetadata[], content: string): boolean {
  return areDocumentChunkMetadataEqual(metadata, buildDocumentChunkMetadata(content));
}

function areDocumentChunkMetadataEqual(left: DocumentChunkMetadata[], right: DocumentChunkMetadata[]): boolean {
  return left.length === right.length
    && left.every((chunk, index) => {
      const expected = right[index];
      return expected
        && chunk.chunkId === expected.chunkId
        && chunk.startLine === expected.startLine
        && chunk.endLine === expected.endLine
        && chunk.startOffset === expected.startOffset
        && chunk.endOffset === expected.endOffset;
    });
}

function selectInspectionChunks(
  chunks: DocumentChunk[],
  question: string,
  maxChunks: number
): PreparedTextInspectionChunk[] {
  const terms = extractSearchTerms(question);
  return chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: scoreInspectionChunk(chunk.indexText, terms)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxChunks)
    .sort((left, right) => left.chunk.startLine - right.chunk.startLine)
    .map((item) => toPreparedInspectionChunk(item.chunk, terms));
}

function toPreparedInspectionChunk(
  chunk: DocumentChunk,
  terms: string[]
): PreparedTextInspectionChunk {
  return {
    chunkId: chunk.chunkId,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    text: buildInspectionInputText(chunk.indexText, terms)
  };
}

function buildInspectionInputText(text: string, terms: string[]): string {
  if (text.length <= INSPECT_CHUNK_CHARS) {
    return text;
  }
  const lower = text.toLowerCase();
  const matchedIndex = terms
    .map((term) => ({
      term,
      index: lower.indexOf(term.toLowerCase()),
      score: scoreSearchTerm(term)
    }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.index;
  if (matchedIndex == null) {
    return compactChars(text, INSPECT_CHUNK_CHARS);
  }
  let contentBudget = INSPECT_CHUNK_CHARS;
  let start = 0;
  let end = 0;
  let prefix = "";
  let suffix = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const halfWindow = Math.floor(contentBudget / 2);
    start = Math.max(0, Math.min(matchedIndex - halfWindow, text.length - contentBudget));
    end = Math.min(text.length, start + contentBudget);
    prefix = start > 0 ? OMITTED_PREFIX : "";
    suffix = end < text.length ? OMITTED_SUFFIX : "";
    const nextBudget = Math.max(1, INSPECT_CHUNK_CHARS - prefix.length - suffix.length);
    if (nextBudget === contentBudget) break;
    contentBudget = nextBudget;
  }
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function extractSearchTerms(question: string): string[] {
  const normalized = question.toLowerCase().trim();
  const words = normalized
    .split(/[^\p{L}\p{N}_]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .filter((item) => !WEAK_ENGLISH_TERMS.has(item));
  const cjkTerms = extractCjkSearchTerms(normalized);
  return Array.from(new Set([
    ...words,
    ...cjkTerms,
    ...(normalized.length >= 2 && normalized.length <= 80 ? [normalized] : [])
  ]));
}

function scoreSearchTerm(term: string): number {
  return term.length
    + (/[^\p{L}\p{N}]/u.test(term) ? 20 : 0)
    + (/[\p{Script=Han}]/u.test(term) ? 6 : 0);
}

function extractCjkSearchTerms(value: string): string[] {
  const terms: string[] = [];
  const segments = value.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const segment of segments) {
    if (segment.length <= 12) {
      terms.push(segment);
    }
    for (const size of [4, 3, 2]) {
      if (segment.length < size) continue;
      for (let index = 0; index <= segment.length - size; index += 1) {
        terms.push(segment.slice(index, index + size));
      }
    }
  }
  return terms.filter((item) => !isWeakCjkTerm(item));
}

function isWeakCjkTerm(value: string): boolean {
  return [
    "什么",
    "哪些",
    "一下",
    "这个",
    "那个",
    "文档",
    "文件",
    "内容",
    "总结",
    "说明",
    "是什么"
  ].includes(value);
}

function scoreInspectionChunk(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => {
    let count = 0;
    let index = lower.indexOf(term);
    while (index >= 0 && count < 5) {
      count += 1;
      index = lower.indexOf(term, index + term.length);
    }
    return score + count * Math.min(term.length, 8);
  }, 0);
}

function combineInspectionAnswers(results: TextInspectionResultItem[]): string {
  const answered = results
    .filter((item) => item.status === "answered" || item.status === "uncertain")
    .map((item) => `L${item.startLine}-L${item.endLine}: ${item.answer}`)
    .filter(Boolean);
  if (answered.length > 0) {
    return answered.join("\n");
  }
  return results
    .map((item) => `L${item.startLine}-L${item.endLine}: ${item.answer}`)
    .filter(Boolean)
    .join("\n");
}

function compactAssetHandleForReplay(value: unknown): Record<string, unknown> | null {
  const handle = objectValue(value);
  if (!handle) return null;
  return {
    assetId: handle.asset_id ?? handle.assetId ?? handle.id ?? null,
    assetRef: handle.asset_ref ?? handle.assetRef ?? null,
    selector: handle.selector ?? null,
    kind: handle.kind ?? null,
    sourceName: handle.source_name ?? handle.sourceName ?? null,
    mimeType: handle.mime_type ?? handle.mimeType ?? null,
    sizeBytes: handle.size_bytes ?? handle.sizeBytes ?? null,
    capabilities: (arrayValue(handle.capabilities) ?? [])
      .map(compactCapabilityForReplay)
      .slice(0, 10),
    nextActions: arrayValue(handle.next_actions)?.slice(0, 4) ?? []
  };
}

function compactCapabilityForReplay(value: unknown): Record<string, unknown> {
  const record = objectValue(value);
  if (!record) return { capability: compactText(String(value ?? ""), 80) };
  return {
    capability: record.capability ?? null,
    tool: record.tool ?? null,
    available: record.available ?? null,
    args: record.args ?? null,
    requires: record.requires ?? null
  };
}

function compactDocumentSummaryForReplay(value: unknown): Record<string, unknown> | null {
  const summary = objectValue(value);
  if (!summary) return null;
  return {
    brief: compactText(String(summary.brief ?? ""), 500),
    outline: (arrayValue(summary.outline) ?? []).map((item) => compactText(String(item ?? ""), 180)).slice(0, 8),
    key_facts: (arrayValue(summary.key_facts ?? summary.keyFacts) ?? []).map((item) => compactText(String(item ?? ""), 220)).slice(0, 8),
    limitations: (arrayValue(summary.limitations) ?? []).map((item) => compactText(String(item ?? ""), 180)).slice(0, 6),
    modelRef: summary.modelRef ?? summary.model_ref ?? null
  };
}

function compactDocumentSummaryScopeForReplay(value: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: value.mode ?? null,
    fullDocument: value.fullDocument ?? value.full_document ?? false,
    sampledChunks: value.sampledChunks ?? value.sampled_chunks ?? null,
    totalChunks: value.totalChunks ?? value.total_chunks ?? null,
    sampledStartLine: value.sampledStartLine ?? value.sampled_start_line ?? null,
    sampledEndLine: value.sampledEndLine ?? value.sampled_end_line ?? null,
    sampledCharacters: value.sampledCharacters ?? value.sampled_characters ?? null
  };
}

function compactDocumentMatchForReplay(value: unknown): Record<string, unknown> {
  const record = objectValue(value);
  if (!record) return { snippet: compactText(String(value ?? ""), SEARCH_SNIPPET_CHARS) };
  return {
    lineNumber: record.line_number ?? record.lineNumber ?? null,
    chunkId: record.chunk_id ?? record.chunkId ?? null,
    startLine: record.start_line ?? record.startLine ?? null,
    endLine: record.end_line ?? record.endLine ?? null,
    charStart: record.char_start ?? record.charStart ?? null,
    charEnd: record.char_end ?? record.charEnd ?? null,
    snippet: compactText(String(record.snippet ?? ""), SEARCH_SNIPPET_CHARS)
  };
}

function compactInspectionResultForReplay(value: unknown): Record<string, unknown> {
  const record = objectValue(value);
  if (!record) return { answer: compactText(String(value ?? ""), 300) };
  return {
    chunkId: record.chunkId ?? record.chunk_id ?? null,
    startLine: record.startLine ?? record.start_line ?? null,
    endLine: record.endLine ?? record.end_line ?? null,
    status: record.status ?? null,
    found: record.found ?? null,
    answer: compactText(String(record.answer ?? ""), 500),
    evidence: (arrayValue(record.evidence) ?? []).map((item) => compactText(String(item ?? ""), 220)).slice(0, 5),
    confidenceNotes: (arrayValue(record.confidenceNotes ?? record.confidence_notes) ?? [])
      .map((item) => compactText(String(item ?? ""), 160))
      .slice(0, 4),
    modelRef: record.modelRef ?? record.model_ref ?? null,
    schemaIssues: arrayValue(record.schemaIssues ?? record.schema_issues)?.slice(0, 6) ?? []
  };
}

function replayJson(
  ctx: Parameters<ToolResultCompactor>[0],
  summary: string,
  data?: Record<string, unknown>
) {
  return {
    summary,
    replayContent: JSON.stringify({
      ok: !hasError(ctx),
      compacted: true,
      tool: ctx.toolName,
      ...(ctx.resource ? { resource: ctx.resource } : {}),
      summary,
      ...(data ? { data } : {}),
      ...(ctx.refetchHint ? { refetch_hint: ctx.refetchHint } : {})
    })
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasError(ctx: ToolResultObservationContext): boolean {
  return Boolean(ctx.parsedContent && typeof ctx.parsedContent.error === "string" && ctx.parsedContent.error.trim());
}

function compactChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

import { createHash } from "node:crypto";
import {
  resolveToolResultCompactor,
  type ToolObservationResource,
  type ToolResultObservationContext,
  type ToolResultObservationPolicy
} from "#llm/tools/core/resultObservation.ts";

export type ToolObservationRetention = "full" | "summary" | "handle" | "omitted";
export type ToolObservationResourceKind =
  | "local_file"
  | "shell_session"
  | "browser_page"
  | "chat_file"
  | "search_result"
  | "external";

export interface ToolObservation {
  contentHash: string;
  inputTokensEstimate: number;
  summary: string;
  retention: ToolObservationRetention;
  replayContent: string;
  resource?: {
    kind: ToolObservationResourceKind;
    id: string;
    locator?: string | undefined;
    version?: string | undefined;
  };
  replaySafe: boolean;
  refetchable: boolean;
  pinned: boolean;
  preserveRecentRawCount?: number;
  includeInHistorySummary?: boolean;
  duplicateOfToolCallId?: string;
}

export interface ToolObservationSummary {
  toolName: string;
  toolCallId: string;
  summary: string;
  timestampMs: number;
  contentHash: string;
  retention: ToolObservationRetention;
  resource?: ToolObservation["resource"];
  pinned: boolean;
}

export interface BuildToolObservationInput {
  toolName: string;
  toolCallId?: string;
  content: string;
  args?: Record<string, unknown>;
  policy?: ToolResultObservationPolicy;
}

interface ToolObservationPolicyError {
  step: string;
  message: string;
}

const SUMMARY_TOOL_NAMES = new Set([
  "local_file_read",
  "local_file_search",
  "local_file_ls",
  "terminal_run",
  "terminal_start",
  "terminal_read",
  "terminal_write",
  "terminal_key",
  "terminal_signal",
  "terminal_stop",
  "inspect_page",
  "interact_with_page",
  "open_page",
  "capture_screenshot",
  "download_asset",
  "ground_with_google_search",
  "search_with_iqs_lite_advanced",
  "view_current_group_info",
  "list_current_group_announcements",
  "list_current_group_members"
]);

const MAX_SUMMARY_TEXT_LENGTH = 260;

export function buildToolObservation(input: BuildToolObservationInput): ToolObservation {
  const parsed = parseJsonObject(input.content);
  const contentHash = hashContent(input.content);
  const estimatedTokens = estimateTokens(input.content);
  const args = input.args ?? {};
  const baseContext: ToolResultObservationContext = {
    toolName: input.toolName,
    toolCallId: input.toolCallId ?? "",
    args,
    rawContent: input.content,
    parsedContent: parsed,
    rawLength: input.content.length,
    estimatedTokens
  };
  const policyErrors: ToolObservationPolicyError[] = [];
  const resource = safePolicyCallback(policyErrors, "resource", () => input.policy?.resource?.(baseContext) ?? null, null)
    ?? extractResource(input.toolName, input.toolCallId, parsed, args);
  const refetchContext = { ...baseContext, resource: resource ?? null };
  const refetchHint = safePolicyCallback(policyErrors, "refetchHint", () => input.policy?.refetchHint?.(refetchContext) ?? null, null)
    ?? buildRefetchHint(input.toolName, parsed, resource, args);
  const pinned = safePolicyCallback(policyErrors, "pinned", () => input.policy?.pinned?.(baseContext) ?? null, null)
    ?? shouldPinToolResult(input.toolName, parsed);
  const policyResult = buildPolicyObservation(input, baseContext, resource ?? null, refetchHint, pinned, policyErrors);
  const summary = policyResult?.summary ?? buildSummary(input.toolName, parsed, resource);
  const retention = policyResult?.retention ?? resolveRetention(input.toolName, input.content, parsed);
  const replayContent = policyResult?.replayContent ?? JSON.stringify({
    ok: !hasToolError(parsed),
    compacted: retention !== "full",
    tool: input.toolName,
    ...(resource ? { resource } : {}),
    summary,
    ...(refetchHint ? { refetch_hint: refetchHint } : {})
  });
  const resolvedResource = policyResult?.resource === null
    ? undefined
    : policyResult?.resource ?? resource;
  const resolvedPinned = policyResult?.pinned ?? pinned;
  const resolvedRefetchHint = policyResult?.refetchHint ?? refetchHint;

  return {
    contentHash,
    inputTokensEstimate: estimatedTokens,
    summary,
    retention,
    replayContent,
    ...(resolvedResource ? { resource: resolvedResource } : {}),
    replaySafe: input.policy?.replaySafe ?? true,
    refetchable: Boolean(resolvedRefetchHint),
    pinned: resolvedPinned,
    ...(input.policy?.preserveRecentRawCount != null ? { preserveRecentRawCount: input.policy.preserveRecentRawCount } : {}),
    ...(input.policy?.includeInHistorySummary != null ? { includeInHistorySummary: input.policy.includeInHistorySummary } : {}),
    ...(parsed?.duplicate_of_tool_call_id ? { duplicateOfToolCallId: String(parsed.duplicate_of_tool_call_id) } : {})
  };
}

function buildPolicyObservation(
  input: BuildToolObservationInput,
  context: ToolResultObservationContext,
  resource: ToolObservationResource | null,
  refetchHint: string | null,
  pinned: boolean,
  policyErrors: ToolObservationPolicyError[]
): {
  summary: string;
  retention: ToolObservationRetention;
  replayContent: string;
  resource?: ToolObservation["resource"] | null;
  refetchHint?: string | null;
  pinned?: boolean;
} | null {
  if (!input.policy) {
    return null;
  }

  const methodErrorCount = policyErrors.length;
  const method = safePolicyCallback(policyErrors, "method", () => input.policy?.method(context) ?? null, null);
  if (policyErrors.length > methodErrorCount) {
    return buildPolicyFailureObservation(input.toolName, resource, refetchHint, pinned, policyErrors.at(-1));
  }
  if (method == null) {
    if (policyErrors.length > 0) {
      return buildPolicyFailureObservation(input.toolName, resource, refetchHint, pinned, policyErrors.at(-1));
    }
    return input.policy
      ? {
          summary: buildSummary(input.toolName, context.parsedContent, resource ?? undefined),
          retention: "full",
          replayContent: input.content,
          resource,
          refetchHint,
          pinned
        }
      : null;
  }

  const compactor = resolveToolResultCompactor(method, input.policy);
  if (!compactor) {
    return buildPolicyFailureObservation(input.toolName, resource, refetchHint, true, {
      step: "compactor",
      message: `结果压缩器未找到：${method}`
    });
  }

  // 压缩器只生成面向 replay/summary 的观察视图，原始 content 仍保存在 transcript。
  const compacted = safePolicyCallback(policyErrors, `compactor:${method}`, () => compactor({
    ...context,
    resource,
    refetchHint,
    pinned
  }), null);
  if (!compacted) {
    return buildPolicyFailureObservation(input.toolName, resource, refetchHint, true, policyErrors.at(-1));
  }
  return {
    summary: compacted.summary,
    retention: "summary",
    replayContent: compacted.replayContent,
    resource: compacted.resource === undefined ? resource : compacted.resource,
    refetchHint: compacted.refetchHint === undefined ? refetchHint : compacted.refetchHint,
    pinned: compacted.pinned ?? pinned
  };
}

function safePolicyCallback<T>(
  errors: ToolObservationPolicyError[],
  step: string,
  callback: () => T,
  fallback: T
): T {
  try {
    return callback();
  } catch (error) {
    errors.push({ step, message: errorToMessage(error) });
    return fallback;
  }
}

function buildPolicyFailureObservation(
  toolName: string,
  resource: ToolObservationResource | null,
  refetchHint: string | null,
  pinned: boolean,
  error: ToolObservationPolicyError | undefined
): {
  summary: string;
  retention: ToolObservationRetention;
  replayContent: string;
  resource?: ToolObservation["resource"] | null;
  refetchHint?: string | null;
  pinned?: boolean;
} {
  const detail = error ? `${error.step}: ${error.message}` : "未知错误";
  const summary = `${toolName} 结果观察策略执行失败，已改用安全摘要：${detail}`;
  return {
    summary,
    retention: "summary",
    replayContent: JSON.stringify({
      ok: false,
      compacted: true,
      tool: toolName,
      summary
    }),
    resource,
    refetchHint,
    pinned
  };
}

export function formatToolObservationForSummary(input: ToolObservationSummary): string {
  const resource = input.resource;
  return [
    `tool=${input.toolName}`,
    `tool_call_id=${input.toolCallId}`,
    resource ? `resource=${resource.kind}:${resource.id}${resource.locator ? ` ${resource.locator}` : ""}` : null,
    `summary=${input.summary}`
  ].filter((item): item is string => Boolean(item)).join(" | ");
}

function resolveRetention(toolName: string, content: string, parsed: Record<string, unknown> | null): ToolObservationRetention {
  if (shouldPinToolResult(toolName, parsed)) {
    return "summary";
  }
  if (SUMMARY_TOOL_NAMES.has(toolName)) {
    return "summary";
  }
  return content.length > 2000 ? "summary" : "full";
}

function shouldPinToolResult(_toolName: string, parsed: Record<string, unknown> | null): boolean {
  if (!parsed) {
    return false;
  }
  if (typeof parsed.error === "string" && parsed.error.trim()) {
    return true;
  }
  const exitCode = Number(parsed.exitCode ?? parsed.exit_code ?? parsed.code);
  return Number.isFinite(exitCode) && exitCode !== 0;
}

function hasToolError(parsed: Record<string, unknown> | null): boolean {
  return Boolean(parsed && typeof parsed.error === "string" && parsed.error.trim());
}

function extractResource(
  toolName: string,
  toolCallId: string | undefined,
  parsed: Record<string, unknown> | null,
  args: Record<string, unknown> = {}
): ToolObservation["resource"] | undefined {
  if (toolName.startsWith("local_file_")) {
    const path = stringValue(parsed?.path ?? parsed?.fromPath ?? parsed?.from_path ?? parsed?.toPath ?? parsed?.to_path
      ?? args.path ?? args.from_path ?? args.to_path);
    if (!path) {
      return undefined;
    }
    const startLine = numberValue(parsed?.startLine ?? parsed?.start_line);
    const endLine = numberValue(parsed?.endLine ?? parsed?.end_line);
    return {
      kind: "local_file",
      id: path,
      ...(startLine && endLine ? { locator: `L${startLine}-L${endLine}` } : {}),
      ...(parsed?.updatedAtMs ? { version: `mtime:${String(parsed.updatedAtMs)}` } : {})
    };
  }

  if (toolName.startsWith("terminal_")) {
    const id = stringValue(parsed?.resource_id ?? parsed?.session_id ?? parsed?.sessionId ?? toolCallId);
    return id ? { kind: "shell_session", id } : undefined;
  }

  if (toolName.includes("page") || toolName === "capture_screenshot") {
    const id = stringValue(parsed?.resource_id ?? parsed?.resourceId ?? toolCallId);
    if (!id) {
      return undefined;
    }
    const lineStart = numberValue(parsed?.lineStart ?? parsed?.line_start);
    const lineEnd = numberValue(parsed?.lineEnd ?? parsed?.line_end);
    return {
      kind: "browser_page",
      id,
      ...(lineStart && lineEnd ? { locator: `L${lineStart}-L${lineEnd}` } : {}),
      ...(parsed?.resolvedUrl ? { version: String(parsed.resolvedUrl) } : {})
    };
  }

  if (isCurrentGroupContextTool(toolName)) {
    const groupId = stringValue(parsed?.groupId ?? parsed?.group_id);
    if (!groupId) {
      return undefined;
    }
    const locator = buildCurrentGroupContextLocator(toolName, parsed);
    return {
      kind: "external",
      id: `onebot:group:${groupId}`,
      ...(locator ? { locator } : {})
    };
  }

  const fileId = stringValue(parsed?.file_id ?? parsed?.fileId);
  if (fileId) {
    return { kind: "chat_file", id: fileId };
  }
  return undefined;
}

function buildRefetchHint(
  toolName: string,
  parsed: Record<string, unknown> | null,
  resource: ToolObservation["resource"] | undefined | null,
  args: Record<string, unknown> = {}
): string | null {
  if (!resource) {
    return null;
  }
  if (toolName === "local_file_read" && resource.kind === "local_file") {
    const startLine = numberValue(parsed?.startLine ?? parsed?.start_line);
    const endLine = numberValue(parsed?.endLine ?? parsed?.end_line);
    return [
      `如需原文，请再次调用 local_file_read path=${resource.id}`,
      startLine ? `start_line=${startLine}` : null,
      endLine ? `end_line=${endLine}` : null
    ].filter((item): item is string => Boolean(item)).join(" ");
  }
  if (resource.kind === "browser_page") {
    return `如需当前页面细节，请再次调用 inspect_page resource_id=${resource.id}`;
  }
  if (resource.kind === "shell_session") {
    return `如需终端后续输出，请再次调用 terminal_read resource_id=${resource.id}`;
  }
  if (isCurrentGroupContextTool(toolName)) {
    if (toolName === "view_current_group_info") {
      return "如需刷新当前群资料，请再次调用 view_current_group_info";
    }
    const query = stringValue(parsed?.query);
    const limit = numberValue(parsed?.limit);
    const args = [
      query ? `query=${JSON.stringify(query)}` : null,
      limit ? `limit=${limit}` : null
    ].filter((item): item is string => Boolean(item)).join(" ");
    return `如需刷新当前群${toolName === "list_current_group_announcements" ? "公告" : "成员"}，请再次调用 ${toolName}${args ? ` ${args}` : ""}`;
  }
  if (toolName === "local_file_ls" && resource.kind === "local_file") {
    return `如需完整目录列表，请再次调用 local_file_ls path=${resource.id} limit=500`;
  }
  if (toolName === "local_file_search" && resource.kind === "local_file") {
    const query = stringValue(args.query);
    const mode = stringValue(args.mode);
    return `如需完整命中，请再次调用 local_file_search${query ? ` query=${JSON.stringify(query)}` : ""} path=${resource.id}${mode ? ` mode=${mode}` : ""} limit=200`;
  }
  return null;
}

function isCurrentGroupContextTool(toolName: string): boolean {
  return toolName === "view_current_group_info"
    || toolName === "list_current_group_announcements"
    || toolName === "list_current_group_members";
}

function buildCurrentGroupContextLocator(
  toolName: string,
  parsed: Record<string, unknown> | null
): string | undefined {
  if (toolName === "view_current_group_info") {
    return "info";
  }
  const query = stringValue(parsed?.query);
  const limit = numberValue(parsed?.limit);
  const parts = [
    toolName === "list_current_group_announcements" ? "announcements" : "members",
    query ? `query=${JSON.stringify(query)}` : null,
    limit ? `limit=${limit}` : null
  ].filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildSummary(
  toolName: string,
  parsed: Record<string, unknown> | null,
  resource: ToolObservation["resource"] | undefined
): string {
  const prefix = resource
    ? `${toolName} ${resource.kind}:${resource.id}${resource.locator ? ` ${resource.locator}` : ""}`
    : toolName;
  const payloadSummary = summarizeParsedPayload(parsed);
  return payloadSummary ? `${prefix}；${payloadSummary}` : prefix;
}

function summarizeParsedPayload(parsed: Record<string, unknown> | null): string {
  if (!parsed) {
    return "";
  }
  const preferred = [
    parsed.error,
    parsed.message,
    parsed.summary,
    parsed.title,
    parsed.content,
    parsed.stdout,
    parsed.stderr
  ].map((item) => stringValue(item)).filter(Boolean);
  if (preferred.length > 0) {
    return compactText(preferred.join("；"), MAX_SUMMARY_TEXT_LENGTH);
  }
  return compactText(JSON.stringify(parsed), MAX_SUMMARY_TEXT_LENGTH);
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function stringValue(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function numberValue(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : null;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { createHash } from "node:crypto";

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
  const resource = extractResource(input.toolName, input.toolCallId, parsed);
  const refetchHint = buildRefetchHint(input.toolName, parsed, resource);
  const summary = buildSummary(input.toolName, parsed, resource);
  const retention = resolveRetention(input.toolName, input.content, parsed);
  const pinned = shouldPinToolResult(input.toolName, parsed);
  const replayContent = JSON.stringify({
    ok: !hasToolError(parsed),
    compacted: retention !== "full",
    tool: input.toolName,
    ...(resource ? { resource } : {}),
    summary,
    ...(refetchHint ? { refetch_hint: refetchHint } : {})
  });

  return {
    contentHash,
    inputTokensEstimate: estimateTokens(input.content),
    summary,
    retention,
    replayContent,
    ...(resource ? { resource } : {}),
    replaySafe: true,
    refetchable: Boolean(refetchHint),
    pinned,
    ...(parsed?.duplicate_of_tool_call_id ? { duplicateOfToolCallId: String(parsed.duplicate_of_tool_call_id) } : {})
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
  parsed: Record<string, unknown> | null
): ToolObservation["resource"] | undefined {
  if (toolName.startsWith("local_file_")) {
    const path = stringValue(parsed?.path ?? parsed?.fromPath ?? parsed?.from_path ?? parsed?.toPath ?? parsed?.to_path);
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
  resource: ToolObservation["resource"] | undefined
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

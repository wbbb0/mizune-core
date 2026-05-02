export type ToolObservationResourceKind =
  | "local_file"
  | "shell_session"
  | "browser_page"
  | "chat_file"
  | "search_result"
  | "external";

export interface ToolObservationResource {
  kind: ToolObservationResourceKind;
  id: string;
  locator?: string | undefined;
  version?: string | undefined;
}

export interface ToolResultObservationContext {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  rawContent: string;
  parsedContent: Record<string, unknown> | null;
  rawLength: number;
  estimatedTokens: number;
}

export interface ToolResultCompactionContext extends ToolResultObservationContext {
  resource: ToolObservationResource | null;
  refetchHint: string | null;
  pinned: boolean;
}

export interface ToolResultCompaction {
  replayContent: string;
  summary: string;
  resource?: ToolObservationResource | null;
  refetchHint?: string | null;
  pinned?: boolean;
}

export type ToolResultCompactor = (ctx: ToolResultCompactionContext) => ToolResultCompaction;

export interface ToolResultObservationPolicy {
  /**
   * 返回 null 表示保留原文；返回字符串表示调用同名压缩器。
   */
  method: (ctx: ToolResultObservationContext) => string | null;
  compactors?: Record<string, ToolResultCompactor>;
  resource?: (ctx: ToolResultObservationContext) => ToolObservationResource | null;
  refetchHint?: (ctx: ToolResultObservationContext & { resource: ToolObservationResource | null }) => string | null;
  pinned?: (ctx: ToolResultObservationContext) => boolean;
  preserveRecentRawCount?: number;
  includeInHistorySummary?: boolean;
  replaySafe?: boolean;
}

export const commonToolResultCompactors: Record<string, ToolResultCompactor> = {
  truncate_text(ctx) {
    const summary = compactText(ctx.rawContent, 400);
    return buildCompaction(ctx, summary);
  },

  json_projection(ctx) {
    const projected = projectJsonPayload(ctx.parsedContent);
    const summary = compactText(JSON.stringify(projected), 400);
    return buildCompaction(ctx, summary, projected);
  },

  handle_only(ctx) {
    const summary = ctx.resource
      ? `${ctx.toolName} 返回 ${ctx.resource.kind}:${ctx.resource.id}${ctx.resource.locator ? ` ${ctx.resource.locator}` : ""}`
      : `${ctx.toolName} 已返回结果`;
    return buildCompaction(ctx, summary);
  },

  error_summary(ctx) {
    const message = stringValue(ctx.parsedContent?.error)
      ?? stringValue(ctx.parsedContent?.message)
      ?? compactText(ctx.rawContent, 300);
    return {
      ...buildCompaction(ctx, `${ctx.toolName} 返回错误：${message}`),
      pinned: true
    };
  },

  list_summary(ctx) {
    const items = arrayValue(ctx.parsedContent?.items)
      ?? arrayValue(ctx.parsedContent?.files)
      ?? arrayValue(ctx.parsedContent?.results)
      ?? arrayValue(ctx.parsedContent)
      ?? [];
    const summary = summarizeList(ctx.toolName, items, ctx.resource);
    return buildCompaction(ctx, summary, {
      count: items.length,
      sample: items.slice(0, 8)
    });
  },

  state_change_summary(ctx) {
    const action = stringValue(ctx.parsedContent?.action)
      ?? (booleanValue(ctx.parsedContent?.changed) === false ? "unchanged" : "updated");
    const target = stringValue(ctx.parsedContent?.targetCategory)
      ?? stringValue(ctx.parsedContent?.itemId)
      ?? stringValue(ctx.resource?.id)
      ?? ctx.toolName;
    const summary = action === "unchanged"
      ? `${target} 未发生变更`
      : `已${translateAction(action)} ${target}`;
    return buildCompaction(ctx, summary, {
      action,
      target,
      warning: ctx.parsedContent?.warning ?? null
    });
  }
};

export function resolveToolResultCompactor(
  method: string,
  policy: ToolResultObservationPolicy | undefined
): ToolResultCompactor | null {
  return policy?.compactors?.[method] ?? commonToolResultCompactors[method] ?? null;
}

export function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

export function stringValue(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

export function numberValue(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : null;
}

export function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function buildCompaction(
  ctx: ToolResultCompactionContext,
  summary: string,
  extra?: Record<string, unknown>
): ToolResultCompaction {
  return {
    summary,
    replayContent: JSON.stringify({
      ok: !hasToolError(ctx.parsedContent),
      compacted: true,
      tool: ctx.toolName,
      ...(ctx.resource ? { resource: ctx.resource } : {}),
      summary,
      ...(extra ? { data: extra } : {}),
      ...(ctx.refetchHint ? { refetch_hint: ctx.refetchHint } : {})
    })
  };
}

function projectJsonPayload(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) {
    return {};
  }
  const projected: Record<string, unknown> = {};
  for (const key of [
    "ok",
    "error",
    "message",
    "summary",
    "path",
    "fromPath",
    "from_path",
    "toPath",
    "to_path",
    "resource_id",
    "resourceId",
    "file_id",
    "fileId",
    "count",
    "total",
    "totalMatched",
    "truncated",
    "exitCode",
    "exit_code",
    "code"
  ]) {
    if (key in parsed) {
      projected[key] = parsed[key];
    }
  }
  for (const key of ["items", "files", "results", "matches"]) {
    const items = arrayValue(parsed[key]);
    if (items) {
      projected[key] = items.slice(0, 8);
      projected[`${key}Count`] = items.length;
    }
  }
  return projected;
}

function summarizeList(
  toolName: string,
  items: unknown[],
  resource: ToolObservationResource | null
): string {
  const base = resource
    ? `${toolName} ${resource.kind}:${resource.id}`
    : toolName;
  const kindCounts = countItemKinds(items);
  const kindText = Object.entries(kindCounts)
    .map(([kind, count]) => `${count} 个 ${kind}`)
    .join("，");
  return `${base} 返回 ${items.length} 项${kindText ? `：${kindText}` : ""}；结果过长，仅保留样本。`;
}

function countItemKinds(items: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const kind = typeof item === "object" && item
      ? stringValue((item as Record<string, unknown>).kind ?? (item as Record<string, unknown>).type)
      : null;
    const key = kind ?? "item";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function hasToolError(parsed: Record<string, unknown> | null): boolean {
  return Boolean(parsed && typeof parsed.error === "string" && parsed.error.trim());
}

function translateAction(action: string): string {
  switch (action) {
    case "created":
    case "create":
      return "创建";
    case "removed":
    case "remove":
    case "deleted":
    case "delete":
      return "删除";
    case "cleared":
    case "clear":
      return "清除";
    case "patched":
    case "patch":
    case "updated":
    case "update":
    default:
      return "更新";
  }
}

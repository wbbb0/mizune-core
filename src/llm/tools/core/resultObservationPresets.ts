import {
  arrayValue,
  booleanValue,
  compactText,
  numberValue,
  stringValue,
  type ToolObservationResource,
  type ToolResultCompactor,
  type ToolResultObservationContext,
  type ToolResultObservationPolicy
} from "./resultObservation.ts";

const LONG_RESULT_CHARS = 2000;
const MANY_LIST_ITEMS = 30;

export function keepRawUnlessLargePolicy(options?: {
  preserveRecentRawCount?: number;
  includeInHistorySummary?: boolean;
  replaySafe?: boolean;
}): ToolResultObservationPolicy {
  return {
    method: defaultMethod,
    ...(options?.preserveRecentRawCount != null ? { preserveRecentRawCount: options.preserveRecentRawCount } : {}),
    ...(options?.includeInHistorySummary != null ? { includeInHistorySummary: options.includeInHistorySummary } : {}),
    ...(options?.replaySafe != null ? { replaySafe: options.replaySafe } : {})
  };
}

export function localFileListPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      const items = arrayValue(ctx.parsedContent?.items) ?? [];
      if (items.length > MANY_LIST_ITEMS || isTruncated(ctx) || ctx.rawLength > LONG_RESULT_CHARS) {
        return "local_file_ls_summary";
      }
      return null;
    },
    resource: localFileResource,
    refetchHint(ctx) {
      return ctx.resource
        ? `如需完整目录列表，请再次调用 local_file_ls path=${ctx.resource.id} limit=500`
        : null;
    },
    preserveRecentRawCount: 1,
    compactors: {
      local_file_ls_summary: compactLocalFileList
    }
  };
}

export function localFileReadPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "local_file_read_summary";
    },
    resource: localFileResource,
    refetchHint(ctx) {
      if (!ctx.resource) return null;
      const startLine = numberValue(ctx.parsedContent?.startLine ?? ctx.parsedContent?.start_line);
      const endLine = numberValue(ctx.parsedContent?.endLine ?? ctx.parsedContent?.end_line);
      return [
        `如需原文，请再次调用 local_file_read path=${ctx.resource.id}`,
        startLine ? `start_line=${startLine}` : null,
        endLine ? `end_line=${endLine}` : null
      ].filter((item): item is string => Boolean(item)).join(" ");
    },
    preserveRecentRawCount: 1,
    compactors: {
      local_file_read_summary: compactLocalFileRead
    }
  };
}

export function localFileSearchPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      const items = arrayValue(ctx.parsedContent?.items)
        ?? arrayValue(ctx.parsedContent?.matches)
        ?? arrayValue(ctx.parsedContent?.results)
        ?? [];
      if (items.length > MANY_LIST_ITEMS || isTruncated(ctx) || ctx.rawLength > LONG_RESULT_CHARS) {
        return "local_file_search_summary";
      }
      return null;
    },
    resource: localFileResource,
    refetchHint(ctx) {
      const query = stringValue(ctx.args.query);
      const mode = stringValue(ctx.args.mode);
      return ctx.resource
        ? `如需完整命中，请再次调用 local_file_search${query ? ` query=${JSON.stringify(query)}` : ""} path=${ctx.resource.id}${mode ? ` mode=${mode}` : ""} limit=200`
        : null;
    },
    preserveRecentRawCount: 1,
    compactors: {
      local_file_search_summary: compactLocalFileSearch
    }
  };
}

export function localFileMutationPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return ctx.rawLength > LONG_RESULT_CHARS ? "state_change_summary" : null;
    },
    resource: localFileResource,
    refetchHint(ctx) {
      return ctx.resource
        ? `如需查看当前内容，请调用 local_file_read path=${ctx.resource.id}`
        : null;
    },
    pinned: hasError,
    preserveRecentRawCount: 1
  };
}

export function terminalPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "terminal_summary";
    },
    resource(ctx) {
      const session = objectValue(ctx.parsedContent?.session);
      const id = stringValue(
        ctx.parsedContent?.resource_id
        ?? ctx.parsedContent?.resourceId
        ?? ctx.parsedContent?.session_id
        ?? ctx.parsedContent?.sessionId
        ?? session?.resource_id
        ?? session?.resourceId
        ?? session?.id
        ?? ctx.args.resource_id
      );
      return id ? { kind: "shell_session", id } : null;
    },
    refetchHint(ctx) {
      if (!ctx.resource) return null;
      return terminalStatus(ctx) === "running"
        ? `如需终端后续输出，请再次调用 terminal_read resource_id=${ctx.resource.id}`
        : "";
    },
    pinned(ctx) {
      return hasError(ctx) || hasNonZeroExitCode(ctx) || stringValue(ctx.parsedContent?.status) === "rejected";
    },
    preserveRecentRawCount: 1,
    compactors: {
      terminal_summary: compactTerminal
    }
  };
}

export function browserPagePolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "browser_page_summary";
    },
    resource: browserResource,
    refetchHint(ctx) {
      return ctx.resource ? `如需当前页面细节，请再次调用 inspect_page resource_id=${ctx.resource.id}` : null;
    },
    preserveRecentRawCount: 1,
    compactors: {
      browser_page_summary: compactBrowserPage
    }
  };
}

export function browserScreenshotPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "browser_media_handle_summary";
    },
    resource: mediaResource,
    refetchHint(ctx) {
      const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
      return fileId ? `如需查看截图，请调用 chat_file_view_media media_ids=[${JSON.stringify(fileId)}]` : null;
    },
    preserveRecentRawCount: 0,
    compactors: {
      browser_media_handle_summary: compactBrowserMediaHandle
    }
  };
}

export function browserDownloadPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "browser_download_handle_summary";
    },
    resource: mediaResource,
    refetchHint(ctx) {
      const fileRef = stringValue(ctx.parsedContent?.file_ref ?? ctx.parsedContent?.fileRef);
      const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
      const selector = fileRef ?? fileId;
      return selector ? `如需发送下载文件，请调用 chat_file_send_to_chat file_ref=${JSON.stringify(selector)}` : null;
    },
    preserveRecentRawCount: 0,
    compactors: {
      browser_download_handle_summary: compactBrowserDownloadHandle
    }
  };
}

export function browserProfilePolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "browser_profile_summary";
    },
    preserveRecentRawCount: 1,
    compactors: {
      browser_profile_summary: compactBrowserProfile
    }
  };
}

export function searchResultPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return ctx.rawLength > LONG_RESULT_CHARS ? "search_result_summary" : null;
    },
    resource(ctx) {
      const query = stringValue(ctx.args.query);
      return query ? { kind: "search_result", id: query } : null;
    },
    preserveRecentRawCount: 1,
    compactors: {
      search_result_summary: compactSearchResult
    }
  };
}

export function currentGroupContextPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return ctx.rawLength > LONG_RESULT_CHARS ? "group_context_summary" : null;
    },
    resource(ctx) {
      const groupId = stringValue(ctx.parsedContent?.groupId ?? ctx.parsedContent?.group_id);
      if (!groupId) return null;
      const locator = currentGroupLocator(ctx);
      return {
        kind: "external",
        id: `onebot:group:${groupId}`,
        ...(locator ? { locator } : {})
      };
    },
    refetchHint(ctx) {
      if (ctx.toolName === "view_current_group_info") return "如需刷新当前群资料，请再次调用 view_current_group_info";
      const query = stringValue(ctx.parsedContent?.query);
      const limit = numberValue(ctx.parsedContent?.limit);
      const args = [
        query ? `query=${JSON.stringify(query)}` : null,
        limit ? `limit=${limit}` : null
      ].filter((item): item is string => Boolean(item)).join(" ");
      return `如需刷新当前群${ctx.toolName === "list_current_group_announcements" ? "公告" : "成员"}，请再次调用 ${ctx.toolName}${args ? ` ${args}` : ""}`;
    },
    preserveRecentRawCount: 1,
    compactors: {
      group_context_summary: compactGroupContext
    }
  };
}

export function directMediaViewPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "media_handle_summary";
    },
    resource: mediaResource,
    refetchHint(ctx) {
      if (!ctx.resource) return null;
      return ctx.toolName.startsWith("local_file_")
        ? `如需重新查看媒体，请调用 local_file_view_media path=${ctx.resource.id}`
        : `如需重新查看媒体，请调用 chat_file_view_media media_ids=[${JSON.stringify(ctx.resource.id)}]`;
    },
    preserveRecentRawCount: 0,
    compactors: {
      media_handle_summary: compactMediaHandle
    }
  };
}

export function mediaInspectionPolicy(): ToolResultObservationPolicy {
  return {
    method: () => null,
    pinned: hasError,
    preserveRecentRawCount: 5
  };
}

export function debugDumpPolicy(): ToolResultObservationPolicy {
  return {
    method: () => "debug_dump_summary",
    includeInHistorySummary: false,
    preserveRecentRawCount: 0,
    compactors: {
      debug_dump_summary(ctx) {
        const summary = `已发送调试 literal：${JSON.stringify(ctx.args.literals ?? [])}`;
        return replayJson(ctx, summary, {
          literals: ctx.args.literals ?? [],
          sentCount: ctx.parsedContent?.sentCount ?? ctx.parsedContent?.sent_count ?? null,
          messageIds: ctx.parsedContent?.messageIds ?? ctx.parsedContent?.message_ids ?? []
        });
      }
    }
  };
}

export function stateChangePolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "state_change_summary";
    },
    pinned: hasError,
    preserveRecentRawCount: 0
  };
}

export function conversationContextPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "conversation_context_summary";
    },
    resource(ctx) {
      const sessionId = stringValue(ctx.parsedContent?.id ?? ctx.args.sessionId);
      return sessionId ? { kind: "external", id: `conversation:${sessionId}` } : null;
    },
    preserveRecentRawCount: 0,
    compactors: {
      conversation_context_summary(ctx) {
        const sessionId = stringValue(ctx.parsedContent?.id ?? ctx.args.sessionId) ?? "<unknown>";
        const title = stringValue(ctx.parsedContent?.title);
        const historySummary = stringValue(ctx.parsedContent?.historySummary);
        const recentMessages = arrayValue(ctx.parsedContent?.recentMessages) ?? [];
        const summary = [
          `已读取会话 ${title ? `${title} (${sessionId})` : sessionId} 的上下文`,
          historySummary ? `摘要：${compactText(historySummary, 280)}` : null,
          recentMessages.length > 0 ? `最近消息 ${recentMessages.length} 条已供本轮参考，跨轮不保留原文。` : null
        ].filter((item): item is string => Boolean(item)).join("；");
        return replayJson(ctx, summary, {
          sessionId,
          title,
          historySummary: historySummary ? compactText(historySummary, 500) : null,
          recentMessageCount: recentMessages.length
        });
      }
    }
  };
}

function defaultMethod(ctx: ToolResultObservationContext): string | null {
  if (hasError(ctx)) return "error_summary";
  if (ctx.rawLength > LONG_RESULT_CHARS) return "json_projection";
  return null;
}

function localFileResource(ctx: ToolResultObservationContext): ToolObservationResource | null {
  const path = stringValue(
    ctx.parsedContent?.path
    ?? ctx.parsedContent?.fromPath
    ?? ctx.parsedContent?.from_path
    ?? ctx.parsedContent?.toPath
    ?? ctx.parsedContent?.to_path
    ?? ctx.args.path
    ?? ctx.args.from_path
    ?? ctx.args.to_path
  );
  if (!path) return null;
  const startLine = numberValue(ctx.parsedContent?.startLine ?? ctx.parsedContent?.start_line);
  const endLine = numberValue(ctx.parsedContent?.endLine ?? ctx.parsedContent?.end_line);
  return {
    kind: "local_file",
    id: path,
    ...(startLine && endLine ? { locator: `L${startLine}-L${endLine}` } : {}),
    ...(ctx.parsedContent?.updatedAtMs ? { version: `mtime:${String(ctx.parsedContent.updatedAtMs)}` } : {})
  };
}

function browserResource(ctx: ToolResultObservationContext): ToolObservationResource | null {
  const snapshot = objectValue(ctx.parsedContent?.snapshot);
  const id = stringValue(
    ctx.parsedContent?.resource_id
    ?? ctx.parsedContent?.resourceId
    ?? snapshot?.resource_id
    ?? snapshot?.resourceId
    ?? ctx.args.resource_id
  );
  if (!id) return null;
  const lineStart = numberValue(
    ctx.parsedContent?.lineStart
    ?? ctx.parsedContent?.line_start
    ?? snapshot?.lineStart
    ?? snapshot?.line_start
  );
  const lineEnd = numberValue(
    ctx.parsedContent?.lineEnd
    ?? ctx.parsedContent?.line_end
    ?? snapshot?.lineEnd
    ?? snapshot?.line_end
  );
  const version = stringValue(
    ctx.parsedContent?.resolvedUrl
    ?? ctx.parsedContent?.resolved_url
    ?? snapshot?.resolvedUrl
    ?? snapshot?.resolved_url
  );
  return {
    kind: "browser_page",
    id,
    ...(lineStart && lineEnd ? { locator: `L${lineStart}-L${lineEnd}` } : {}),
    ...(version ? { version } : {})
  };
}

function mediaResource(ctx: ToolResultObservationContext): ToolObservationResource | null {
  const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
  if (fileId) return { kind: "chat_file", id: fileId };
  const path = stringValue(ctx.parsedContent?.path ?? ctx.args.path);
  if (path) return { kind: "local_file", id: path };
  const attached = arrayValue(ctx.parsedContent?.attached);
  const mediaId = attached && attached.length === 1 && typeof attached[0] === "object"
    ? stringValue((attached[0] as Record<string, unknown>).mediaId)
    : null;
  return mediaId ? { kind: "chat_file", id: mediaId } : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactLocalFileList(ctx: Parameters<ToolResultCompactor>[0]) {
  const items = arrayValue(ctx.parsedContent?.items) ?? [];
  const dirCount = items.filter((item) => itemKind(item) === "directory").length;
  const fileCount = items.filter((item) => itemKind(item) === "file").length;
  const summary = `目录 ${ctx.resource?.id ?? "."} 返回 ${items.length} 项：${dirCount} 个目录，${fileCount} 个文件；结果过长，仅保留样本。`;
  return replayJson(ctx, summary, {
    itemCount: items.length,
    directoryCount: dirCount,
    fileCount,
    sample: items.slice(0, 12),
    truncated: isTruncated(ctx)
  });
}

function compactLocalFileRead(ctx: Parameters<ToolResultCompactor>[0]) {
  const lineText = ctx.resource?.locator ? ` 的 ${ctx.resource.locator}` : "";
  const content = stringValue(ctx.parsedContent?.content) ?? "";
  const summary = `读取了 ${ctx.resource?.id ?? "本地文件"}${lineText}；${compactText(content, 320)}${isTruncated(ctx) ? "；结果被截断，后续还有内容未读。" : ""}`;
  return replayJson(ctx, summary, {
    path: ctx.resource?.id ?? null,
    locator: ctx.resource?.locator ?? null,
    truncated: isTruncated(ctx)
  });
}

function compactLocalFileSearch(ctx: Parameters<ToolResultCompactor>[0]) {
  const items = arrayValue(ctx.parsedContent?.items)
    ?? arrayValue(ctx.parsedContent?.matches)
    ?? arrayValue(ctx.parsedContent?.results)
    ?? [];
  const query = stringValue(ctx.args.query) ?? "<empty>";
  const summary = `在 ${ctx.resource?.id ?? "."} 中搜索 ${JSON.stringify(query)}，返回 ${items.length} 条结果；结果过长，仅保留样本。`;
  return replayJson(ctx, summary, {
    query,
    resultCount: items.length,
    sample: items.slice(0, 10),
    truncated: isTruncated(ctx)
  });
}

function compactTerminal(ctx: Parameters<ToolResultCompactor>[0]) {
  const session = objectValue(ctx.parsedContent?.session);
  const stdout = stringValue(ctx.parsedContent?.stdout ?? ctx.parsedContent?.output) ?? "";
  const stderr = stringValue(ctx.parsedContent?.stderr) ?? "";
  const exitCode = ctx.parsedContent?.exitCode ?? ctx.parsedContent?.exit_code ?? ctx.parsedContent?.code
    ?? session?.exitCode ?? session?.exit_code ?? session?.code ?? null;
  const status = stringValue(ctx.parsedContent?.status ?? session?.status);
  const command = stringValue(ctx.parsedContent?.command ?? session?.command);
  const cwd = stringValue(ctx.parsedContent?.cwd ?? session?.cwd);
  const policy = objectValue(ctx.parsedContent?.policy);
  const summary = [
    `终端工具 ${ctx.toolName} 返回`,
    status ? `status=${status}` : null,
    exitCode != null ? `exitCode=${String(exitCode)}` : null,
    command ? `command=${compactText(command, 100)}` : null,
    stderr ? `stderr=${compactText(stderr, 180)}` : null,
    stdout ? `输出尾部=${compactText(stdout.slice(-600), 240)}` : null
  ].filter((item): item is string => Boolean(item)).join("；");
  return replayJson(ctx, summary, {
    resourceId: ctx.resource?.id ?? null,
    command,
    cwd,
    status,
    exitCode,
    stderr: compactText(stderr, 300),
    outputTail: compactText(stdout.slice(-1200), 600),
    outputTruncated: isTruncated(ctx),
    policy: policy
      ? {
          decision: policy.decision ?? null,
          reason: policy.reason ?? null,
          warnings: arrayValue(policy.warnings)?.slice(0, 5) ?? []
        }
      : null
  });
}

function compactBrowserPage(ctx: Parameters<ToolResultCompactor>[0]) {
  const snapshot = objectValue(ctx.parsedContent?.snapshot) ?? ctx.parsedContent;
  const title = stringValue(snapshot?.title);
  const url = stringValue(snapshot?.resolvedUrl ?? snapshot?.resolved_url ?? snapshot?.url);
  const lines = arrayValue(snapshot?.lines)?.map((item) => String(item)).slice(0, 12) ?? [];
  const elements = arrayValue(snapshot?.elements)
    ?.map(compactBrowserElementForReplay)
    .slice(0, 12)
    ?? [];
  const matches = arrayValue(ctx.parsedContent?.matches ?? snapshot?.matches)
    ?.map(compactBrowserMatchForReplay)
    .slice(0, 10)
    ?? [];
  const action = stringValue(ctx.parsedContent?.action);
  const message = stringValue(ctx.parsedContent?.message);
  const revision = ctx.parsedContent?.revision ?? snapshot?.revision ?? null;
  const summary = [
    `浏览器页面 ${title ?? url ?? ctx.resource?.id ?? ""} 返回内容`,
    action ? `action=${action}` : null,
    message ? compactText(message, 160) : null,
    lines.length > 0 ? `文本样本=${compactText(lines.join(" "), 260)}` : null,
    elements.length > 0 ? `可交互元素=${elements.length} 个样本` : null
  ].filter((item): item is string => Boolean(item)).join("；");
  return replayJson(ctx, summary, {
    title,
    url,
    resourceId: ctx.resource?.id ?? null,
    revision,
    locator: ctx.resource?.locator ?? null,
    lineWindow: {
      start: numberValue(snapshot?.lineStart ?? snapshot?.line_start) ?? null,
      end: numberValue(snapshot?.lineEnd ?? snapshot?.line_end) ?? null,
      sample: lines,
      truncated: isTruncated(ctx) || booleanValue(snapshot?.truncated) === true
    },
    refs: elements,
    matches,
    action,
    message
  });
}

function compactBrowserMediaHandle(ctx: Parameters<ToolResultCompactor>[0]) {
  const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
  const fileRef = stringValue(ctx.parsedContent?.file_ref ?? ctx.parsedContent?.fileRef);
  const resourceId = stringValue(ctx.parsedContent?.resource_id ?? ctx.parsedContent?.resourceId);
  const targetId = ctx.parsedContent?.target_id ?? ctx.parsedContent?.targetId ?? null;
  const summary = `浏览器截图已保存${fileId ? `：${fileId}` : ""}`;
  return replayJson(ctx, summary, {
    fileId,
    fileRef,
    resourceId,
    targetId,
    mode: ctx.parsedContent?.mode ?? null,
    mimeType: ctx.parsedContent?.mime_type ?? ctx.parsedContent?.mimeType ?? null,
    sizeBytes: ctx.parsedContent?.size_bytes ?? ctx.parsedContent?.sizeBytes ?? null
  });
}

function compactBrowserDownloadHandle(ctx: Parameters<ToolResultCompactor>[0]) {
  const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
  const fileRef = stringValue(ctx.parsedContent?.file_ref ?? ctx.parsedContent?.fileRef);
  const sourceUrl = stringValue(ctx.parsedContent?.source_url ?? ctx.parsedContent?.sourceUrl);
  const summary = `浏览器下载已保存${fileId ? `：${fileId}` : ""}${sourceUrl ? `，来源 ${compactText(sourceUrl, 120)}` : ""}`;
  return replayJson(ctx, summary, {
    fileId,
    fileRef,
    kind: ctx.parsedContent?.kind ?? null,
    sourceUrl,
    resourceId: ctx.parsedContent?.resource_id ?? ctx.parsedContent?.resourceId ?? null,
    targetId: ctx.parsedContent?.target_id ?? ctx.parsedContent?.targetId ?? null,
    mimeType: ctx.parsedContent?.mime_type ?? ctx.parsedContent?.mimeType ?? null,
    sizeBytes: ctx.parsedContent?.size_bytes ?? ctx.parsedContent?.sizeBytes ?? null
  });
}

function compactBrowserProfile(ctx: Parameters<ToolResultCompactor>[0]) {
  const profiles = arrayValue(ctx.parsedContent?.profiles) ?? [];
  const profile = objectValue(ctx.parsedContent?.profile);
  const profileId = stringValue(ctx.parsedContent?.profile_id ?? profile?.profile_id);
  const summary = profileId
    ? `浏览器 profile ${profileId} 已返回摘要`
    : `浏览器 profile 列表返回 ${profiles.length} 项`;
  return replayJson(ctx, summary, {
    profileId,
    profileCount: profiles.length,
    origins: arrayValue(profile?.origins)?.slice(0, 12) ?? [],
    sample: profiles.slice(0, 8)
  });
}

function compactSearchResult(ctx: Parameters<ToolResultCompactor>[0]) {
  const results = arrayValue(ctx.parsedContent?.results)
    ?? arrayValue(ctx.parsedContent?.items)
    ?? [];
  const query = stringValue(ctx.args.query) ?? ctx.resource?.id ?? "";
  const summary = `搜索 ${JSON.stringify(query)} 返回 ${results.length} 条结果；保留 top refs 和摘要样本。`;
  return replayJson(ctx, summary, {
    query,
    resultCount: results.length,
    sample: results.slice(0, 8)
  });
}

function compactBrowserElementForReplay(item: unknown): Record<string, unknown> {
  const element = objectValue(item);
  if (!element) {
    return { text: compactText(String(item ?? ""), 120) };
  }
  return {
    ref: element.ref ?? element.id ?? null,
    role: element.role ?? null,
    name: element.name ?? element.label ?? null,
    action: element.action ?? null,
    disabled: element.disabled === true,
    text: stringValue(element.text) ? compactText(String(element.text), 120) : null,
    href: element.href ?? null
  };
}

function compactBrowserMatchForReplay(item: unknown): Record<string, unknown> {
  const match = objectValue(item);
  if (!match) {
    return { text: compactText(String(item ?? ""), 160) };
  }
  return {
    line: match.lineNumber ?? match.line ?? null,
    text: stringValue(match.text) ? compactText(String(match.text), 180) : null
  };
}

function compactGroupContext(ctx: Parameters<ToolResultCompactor>[0]) {
  const summary = stringValue(ctx.parsedContent?.summary)
    ?? `${ctx.toolName} 返回当前群上下文`;
  const items = arrayValue(ctx.parsedContent?.items) ?? [];
  return replayJson(ctx, summary, {
    groupResource: ctx.resource,
    itemCount: items.length,
    sample: items.slice(0, 8)
  });
}

function compactMediaHandle(ctx: Parameters<ToolResultCompactor>[0]) {
  const summary = `${ctx.toolName} 已提供媒体上下文：${ctx.resource ? `${ctx.resource.kind}:${ctx.resource.id}` : "无资源句柄"}`;
  return replayJson(ctx, summary, {
    resource: ctx.resource,
    caption: ctx.parsedContent?.caption ?? null,
    workspace: ctx.parsedContent?.workspace ?? null,
    audio: ctx.parsedContent?.audio ?? null
  });
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

function currentGroupLocator(ctx: ToolResultObservationContext): string | undefined {
  if (ctx.toolName === "view_current_group_info") return "info";
  const query = stringValue(ctx.parsedContent?.query);
  const limit = numberValue(ctx.parsedContent?.limit);
  return [
    ctx.toolName === "list_current_group_announcements" ? "announcements" : "members",
    query ? `query=${JSON.stringify(query)}` : null,
    limit ? `limit=${limit}` : null
  ].filter((item): item is string => Boolean(item)).join(" ");
}

function hasError(ctx: ToolResultObservationContext): boolean {
  return Boolean(ctx.parsedContent && typeof ctx.parsedContent.error === "string" && ctx.parsedContent.error.trim());
}

function hasNonZeroExitCode(ctx: ToolResultObservationContext): boolean {
  const session = objectValue(ctx.parsedContent?.session);
  const exitCode = Number(
    ctx.parsedContent?.exitCode
    ?? ctx.parsedContent?.exit_code
    ?? ctx.parsedContent?.code
    ?? session?.exitCode
    ?? session?.exit_code
    ?? session?.code
  );
  return Number.isFinite(exitCode) && exitCode !== 0;
}

function terminalStatus(ctx: ToolResultObservationContext): string | null {
  const session = objectValue(ctx.parsedContent?.session);
  return stringValue(ctx.parsedContent?.status ?? session?.status);
}

function isTruncated(ctx: ToolResultObservationContext): boolean {
  return booleanValue(ctx.parsedContent?.truncated)
    ?? booleanValue(ctx.parsedContent?.outputTruncated)
    ?? booleanValue(ctx.parsedContent?.output_truncated)
    ?? false;
}

function itemKind(item: unknown): string | null {
  return typeof item === "object" && item
    ? stringValue((item as Record<string, unknown>).kind ?? (item as Record<string, unknown>).type)
    : null;
}

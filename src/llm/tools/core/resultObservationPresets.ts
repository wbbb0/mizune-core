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
      return "filesystem_list_summary";
    },
    resource: localFileResource,
    refetchHint(ctx) {
      if (!ctx.resource) return null;
      const kind = stringValue(ctx.parsedContent?.kind);
      return kind === "file"
        ? `如需刷新文件元信息，请再次调用 filesystem_list path=${ctx.resource.id}`
        : `如需完整目录列表，请再次调用 filesystem_list path=${ctx.resource.id} limit=500`;
    },
    preserveRecentRawCount: 1,
    compactors: {
      filesystem_list_summary: compactLocalFileList
    }
  };
}

export function localFileReadPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "filesystem_read_summary";
    },
    resource: localFileResource,
    refetchHint(ctx) {
      if (!ctx.resource) return null;
      const startLine = numberValue(ctx.parsedContent?.startLine ?? ctx.parsedContent?.start_line);
      const endLine = numberValue(ctx.parsedContent?.endLine ?? ctx.parsedContent?.end_line);
      return [
        `如需原文，请再次调用 filesystem_read path=${ctx.resource.id}`,
        startLine ? `start_line=${startLine}` : null,
        endLine ? `end_line=${endLine}` : null
      ].filter((item): item is string => Boolean(item)).join(" ");
    },
    preserveRecentRawCount: 1,
    compactors: {
      filesystem_read_summary: compactLocalFileRead
    }
  };
}

export function localFileSearchPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "filesystem_search_summary";
    },
    resource: localFileResource,
    refetchHint(ctx) {
      const query = stringValue(ctx.args.query);
      const mode = stringValue(ctx.args.mode);
      return ctx.resource
        ? `如需完整命中，请再次调用 filesystem_search${query ? ` query=${JSON.stringify(query)}` : ""} path=${ctx.resource.id}${mode ? ` mode=${mode}` : ""} limit=200`
        : null;
    },
    preserveRecentRawCount: 1,
    compactors: {
      filesystem_search_summary: compactLocalFileSearch
    }
  };
}

export function localFileMutationPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "filesystem_mutation_summary";
    },
    resource: localFileResource,
    refetchHint: localFileMutationRefetchHint,
    pinned: hasError,
    preserveRecentRawCount: 1,
    compactors: {
      filesystem_mutation_summary: compactLocalFileMutation
    }
  };
}

export function chatFileListPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "asset_list_summary";
    },
    resource: chatFileResource,
    refetchHint(ctx) {
      if (ctx.resource?.kind === "asset") {
        return `如需刷新该 asset 记录，请再次调用 asset_list asset_ref=${JSON.stringify(ctx.resource.id)}`;
      }
      const query = stringValue(ctx.args.query);
      const kind = stringValue(ctx.args.kind);
      const origin = stringValue(ctx.args.origin);
      const args = [
        query ? `query=${JSON.stringify(query)}` : null,
        kind ? `kind=${kind}` : null,
        origin ? `origin=${origin}` : null,
        "limit=100"
      ].filter((item): item is string => Boolean(item)).join(" ");
      return `如需刷新 asset 列表，请再次调用 asset_list ${args}`;
    },
    preserveRecentRawCount: 1,
    compactors: {
      asset_list_summary: compactChatFileList
    }
  };
}

export function fileSendPolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "file_send_summary";
    },
    resource: fileSendResource,
    refetchHint(ctx) {
      if (!ctx.resource) return null;
      return ctx.resource.kind === "asset"
        ? `如需再次发送该文件，请调用 asset_send_to_chat asset_ref=${JSON.stringify(ctx.resource.id)}`
        : `如需再次发送该本地文件，请调用 filesystem_send_to_chat path=${JSON.stringify(ctx.resource.id)}`;
    },
    preserveRecentRawCount: 0,
    compactors: {
      file_send_summary: compactFileSend
    }
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
      return fileId ? `如需查看截图，请调用 asset_media_view asset_id=${JSON.stringify(fileId)}` : null;
    },
    preserveRecentRawCount: 0,
    compactors: {
      browser_media_handle_summary: compactBrowserMediaHandle
    }
  };
}

export function browserDownloadPolicy(): ToolResultObservationPolicy {
  return downloadResourcePolicy();
}

export function downloadResourcePolicy(): ToolResultObservationPolicy {
  return {
    method(ctx) {
      if (hasError(ctx)) return "error_summary";
      return "download_handle_summary";
    },
    resource: downloadOrMediaResource,
    refetchHint(ctx) {
      const fileRef = stringValue(ctx.parsedContent?.file_ref ?? ctx.parsedContent?.fileRef);
      const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
      const selector = fileRef ?? fileId;
      if (selector) {
        return `如需发送下载文件，请调用 asset_send_to_chat asset_ref=${JSON.stringify(selector)}`;
      }
      const resourceId = stringValue(ctx.parsedContent?.resource_id ?? ctx.parsedContent?.resourceId);
      return resourceId ? `如需查看下载状态，请调用 read_download_resource resource_id=${JSON.stringify(resourceId)}` : null;
    },
    preserveRecentRawCount: 0,
    compactors: {
      download_handle_summary: compactDownloadHandle
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
      if (ctx.toolName === "view_current_group_announcement") return "group_announcement_detail_summary";
      if (ctx.toolName === "download_current_group_file") return "download_handle_summary";
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
      if (ctx.toolName === "view_current_group_announcement") {
        const announcementId = stringValue(ctx.parsedContent?.announcementId ?? ctx.parsedContent?.announcement_id);
        const nextStartLine = numberValue(ctx.parsedContent?.nextStartLine ?? ctx.parsedContent?.next_start_line);
        const nextStartChar = numberValue(ctx.parsedContent?.nextStartChar ?? ctx.parsedContent?.next_start_char);
        const startLine = nextStartLine ?? numberValue(ctx.parsedContent?.startLine ?? ctx.parsedContent?.start_line);
        const startChar = nextStartChar ?? numberValue(ctx.parsedContent?.startChar ?? ctx.parsedContent?.start_char);
        const lineCount = numberValue(
          ctx.parsedContent?.requestedLineCount
          ?? ctx.parsedContent?.lineCount
          ?? ctx.parsedContent?.line_count
        );
        return [
          nextStartLine ? "如需继续查看当前群公告原文，请再次调用 view_current_group_announcement" : "如需重新查看当前群公告原文片段，请再次调用 view_current_group_announcement",
          announcementId ? `announcementId=${JSON.stringify(announcementId)}` : null,
          startLine ? `startLine=${startLine}` : null,
          startChar ? `startChar=${startChar}` : null,
          lineCount ? `lineCount=${lineCount}` : null
        ].filter((item): item is string => Boolean(item)).join(" ");
      }
      if (ctx.toolName === "download_current_group_file") {
        const groupFileId = stringValue(ctx.parsedContent?.groupFileId ?? ctx.parsedContent?.group_file_id);
        const resourceId = stringValue(ctx.parsedContent?.resource_id ?? ctx.parsedContent?.resourceId);
        return resourceId
          ? `如需查看下载状态，请调用 read_download_resource resource_id=${JSON.stringify(resourceId)}${groupFileId ? `；群文件 group_file_id=${JSON.stringify(groupFileId)}` : ""}`
          : `如需查看下载状态，请调用 list_live_resources type=download${groupFileId ? `；群文件 group_file_id=${JSON.stringify(groupFileId)}` : ""}`;
      }
      const query = stringValue(ctx.parsedContent?.query);
      const limit = numberValue(ctx.parsedContent?.limit);
      const args = [
        query ? `query=${JSON.stringify(query)}` : null,
        limit ? `limit=${limit}` : null
      ].filter((item): item is string => Boolean(item)).join(" ");
      const label = ctx.toolName === "list_current_group_announcements"
        ? "公告"
        : ctx.toolName === "list_current_group_files"
          ? "文件"
          : "成员";
      return `如需刷新当前群${label}，请再次调用 ${ctx.toolName}${args ? ` ${args}` : ""}`;
    },
    preserveRecentRawCount: 1,
    compactors: {
      group_context_summary: compactGroupContext,
      group_announcement_detail_summary: compactGroupAnnouncementDetail,
      download_handle_summary: compactDownloadHandle
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
      return ctx.toolName.startsWith("filesystem_")
        ? `如需重新查看媒体，请调用 filesystem_media_view path=${ctx.resource.id}`
        : `如需重新查看媒体，请调用 asset_media_view asset_id=${JSON.stringify(ctx.resource.id)}`;
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
    ?? ctx.parsedContent?.toPath
    ?? ctx.parsedContent?.to_path
    ?? ctx.parsedContent?.fromPath
    ?? ctx.parsedContent?.from_path
    ?? ctx.args.path
    ?? ctx.args.to_path
    ?? ctx.args.from_path
  );
  if (!path) return null;
  const startLine = numberValue(ctx.parsedContent?.startLine ?? ctx.parsedContent?.start_line);
  const endLine = numberValue(ctx.parsedContent?.endLine ?? ctx.parsedContent?.end_line);
  return {
    kind: "filesystem",
    id: path,
    ...(startLine && endLine ? { locator: `L${startLine}-L${endLine}` } : {}),
    ...(ctx.parsedContent?.updatedAtMs ? { version: `mtime:${String(ctx.parsedContent.updatedAtMs)}` } : {})
  };
}

function chatFileResource(ctx: ToolResultObservationContext): ToolObservationResource | null {
  const file = objectValue(ctx.parsedContent?.file);
  if ("file" in (ctx.parsedContent ?? {}) && !file) {
    return null;
  }
  const id = stringValue(
    ctx.parsedContent?.asset_ref
    ?? ctx.parsedContent?.file_ref
    ?? ctx.parsedContent?.fileRef
    ?? ctx.parsedContent?.file_id
    ?? ctx.parsedContent?.fileId
    ?? file?.file_ref
    ?? file?.fileRef
    ?? file?.file_id
    ?? file?.fileId
    ?? ctx.args.asset_ref
    ?? ctx.args.file_ref
    ?? ctx.args.file_id
  );
  return id ? { kind: "asset", id } : null;
}

function fileSendResource(ctx: ToolResultObservationContext): ToolObservationResource | null {
  const fileRef = stringValue(ctx.parsedContent?.asset_ref ?? ctx.parsedContent?.file_ref ?? ctx.parsedContent?.fileRef);
  if (fileRef) return { kind: "asset", id: fileRef };
  const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
  if (fileId) return { kind: "asset", id: fileId };
  const path = stringValue(ctx.parsedContent?.path ?? ctx.args.path);
  if (path) return { kind: "filesystem", id: path };
  return null;
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
  if (fileId) return { kind: "asset", id: fileId };
  const path = stringValue(ctx.parsedContent?.path ?? ctx.args.path);
  if (path) return { kind: "filesystem", id: path };
  const attached = arrayValue(ctx.parsedContent?.attached);
  const mediaId = attached && attached.length === 1 && typeof attached[0] === "object"
    ? stringValue((attached[0] as Record<string, unknown>).mediaId)
    : null;
  return mediaId ? { kind: "asset", id: mediaId } : null;
}

function downloadOrMediaResource(ctx: ToolResultObservationContext): ToolObservationResource | null {
  const media = mediaResource(ctx);
  if (media) return media;
  const resourceId = stringValue(ctx.parsedContent?.resource_id ?? ctx.parsedContent?.resourceId ?? ctx.args.resource_id);
  return resourceId ? { kind: "external", id: `download:${resourceId}` } : null;
}

function localFileMutationRefetchHint(ctx: ToolResultObservationContext & { resource: ToolObservationResource | null }): string | null {
  if (ctx.toolName === "filesystem_delete") return "";
  const path = stringValue(
    ctx.parsedContent?.path
    ?? ctx.parsedContent?.toPath
    ?? ctx.parsedContent?.to_path
    ?? ctx.args.path
    ?? ctx.args.to_path
    ?? ctx.resource?.id
  );
  if (!path) return null;
  if (ctx.toolName === "filesystem_mkdir") {
    return `如需查看目录内容，请调用 filesystem_list path=${path}`;
  }
  return `如需查看当前内容，请调用 filesystem_read path=${path}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactLocalFileList(ctx: Parameters<ToolResultCompactor>[0]) {
  const items = arrayValue(ctx.parsedContent?.items) ?? [];
  const kind = stringValue(ctx.parsedContent?.kind);
  if (kind && items.length === 0) {
    const path = stringValue(ctx.parsedContent?.path) ?? ctx.resource?.id ?? ".";
    const summary = `本地路径 ${path} 是 ${kind === "directory" ? "目录" : "文件"}`;
    return replayJson(ctx, summary, {
      path,
      name: ctx.parsedContent?.name ?? null,
      kind,
      sizeBytes: ctx.parsedContent?.sizeBytes ?? ctx.parsedContent?.size_bytes ?? null,
      updatedAtMs: ctx.parsedContent?.updatedAtMs ?? ctx.parsedContent?.updated_at_ms ?? null,
      handle: compactFileHandleForReplay(ctx.parsedContent?.handle),
      handleCapabilities: arrayValue(ctx.parsedContent?.handle_capabilities)
        ?.map(compactFileHandleCapabilityForReplay)
        .slice(0, 6) ?? [],
      nextActions: arrayValue(ctx.parsedContent?.next_actions)?.slice(0, 4) ?? []
    });
  }
  const dirCount = items.filter((item) => itemKind(item) === "directory").length;
  const fileCount = items.filter((item) => itemKind(item) === "file").length;
  const summary = `目录 ${ctx.resource?.id ?? "."} 返回 ${items.length} 项：${dirCount} 个目录，${fileCount} 个文件${isTruncated(ctx) ? "；结果被截断" : ""}。`;
  return replayJson(ctx, summary, {
    path: ctx.resource?.id ?? stringValue(ctx.parsedContent?.path) ?? ".",
    itemCount: items.length,
    directoryCount: dirCount,
    fileCount,
    sample: items.map(compactLocalFileItemForReplay).slice(0, 16),
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
  const mode = stringValue(ctx.args.mode)
    ?? (arrayValue(ctx.parsedContent?.matches) ? "content" : "name");
  const summary = `在 ${ctx.resource?.id ?? "."} 中按 ${mode} 搜索 ${JSON.stringify(query)}，返回 ${items.length} 条结果${isTruncated(ctx) ? "；结果被截断" : ""}。`;
  return replayJson(ctx, summary, {
    query,
    mode,
    resultCount: items.length,
    sample: items.map(compactLocalSearchItemForReplay).slice(0, 12),
    truncated: isTruncated(ctx)
  });
}

function compactLocalFileMutation(ctx: Parameters<ToolResultCompactor>[0]) {
  const path = stringValue(
    ctx.parsedContent?.path
    ?? ctx.parsedContent?.toPath
    ?? ctx.parsedContent?.to_path
    ?? ctx.parsedContent?.fromPath
    ?? ctx.parsedContent?.from_path
    ?? ctx.args.path
    ?? ctx.args.to_path
    ?? ctx.args.from_path
  );
  const action = localMutationAction(ctx.toolName);
  const targetLabel = localMutationTargetLabel(ctx.toolName);
  const summary = [
    `${action}${targetLabel}${path ? ` ${path}` : ""}`,
    ctx.parsedContent?.bytesWritten != null || ctx.parsedContent?.bytes_written != null
      ? `bytes=${String(ctx.parsedContent.bytesWritten ?? ctx.parsedContent.bytes_written)}`
      : null,
    ctx.parsedContent?.hunksApplied != null || ctx.parsedContent?.hunks_applied != null
      ? `hunks=${String(ctx.parsedContent.hunksApplied ?? ctx.parsedContent.hunks_applied)}`
      : null,
    ctx.parsedContent?.deleted === false ? "目标原本不存在" : null
  ].filter((item): item is string => Boolean(item)).join("；");
  return replayJson(ctx, summary, {
    action: ctx.toolName,
    path,
    fromPath: ctx.parsedContent?.fromPath ?? ctx.parsedContent?.from_path ?? ctx.args.from_path ?? null,
    toPath: ctx.parsedContent?.toPath ?? ctx.parsedContent?.to_path ?? ctx.args.to_path ?? null,
    bytesWritten: ctx.parsedContent?.bytesWritten ?? ctx.parsedContent?.bytes_written ?? null,
    hunksApplied: ctx.parsedContent?.hunksApplied ?? ctx.parsedContent?.hunks_applied ?? null,
    deleted: ctx.parsedContent?.deleted ?? null,
    updatedAtMs: ctx.parsedContent?.updatedAtMs ?? ctx.parsedContent?.updated_at_ms ?? null
  });
}

function compactChatFileList(ctx: Parameters<ToolResultCompactor>[0]) {
  const file = objectValue(ctx.parsedContent?.file);
  const files = arrayValue(ctx.parsedContent?.files) ?? [];
  const sample = (file ? [file] : files).map(compactChatFileForReplay).slice(0, file ? 1 : 12);
  const ok = booleanValue(ctx.parsedContent?.ok);
  if (ok === false && !file) {
    const selector = stringValue(ctx.args.file_ref ?? ctx.args.file_id) ?? "<unknown>";
    return replayJson(ctx, `asset 未找到：${selector}`, {
      ok: false,
      selector,
      found: false
    });
  }
  const total = numberValue(ctx.parsedContent?.totalMatched ?? ctx.parsedContent?.total_matched)
    ?? (file ? 1 : files.length);
  const filters = objectValue(ctx.parsedContent?.filters);
  const summary = file
    ? `asset ${stringValue(file.file_ref ?? file.fileRef ?? file.file_id ?? file.fileId) ?? ctx.resource?.id ?? ""} 已返回记录`
    : `asset 列表返回 ${files.length}/${total} 项${isTruncated(ctx) ? "；结果被截断" : ""}`;
  return replayJson(ctx, summary, {
    file: file ? sample[0] : null,
    fileCount: file ? 1 : files.length,
    totalMatched: total,
    filters: filters ?? {
      query: ctx.args.query ?? null,
      kind: ctx.args.kind ?? null,
      origin: ctx.args.origin ?? null
    },
    sample,
    kindCounts: countBy(sample, "kind"),
    originCounts: countBy(sample, "origin"),
    truncated: isTruncated(ctx),
    nextActions: arrayValue(ctx.parsedContent?.next_actions)?.slice(0, 4) ?? []
  });
}

function compactFileSend(ctx: Parameters<ToolResultCompactor>[0]) {
  const fileRef = stringValue(ctx.parsedContent?.file_ref ?? ctx.parsedContent?.fileRef);
  const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
  const path = stringValue(ctx.parsedContent?.path);
  const deliveredAs = stringValue(ctx.parsedContent?.deliveredAs ?? ctx.parsedContent?.delivered_as);
  const queued = booleanValue(ctx.parsedContent?.queued) === true;
  const target = fileRef ?? fileId ?? path ?? ctx.resource?.id ?? "";
  const summary = `${ctx.toolName} 已${queued ? "排队" : "完成"}发送${target ? `：${target}` : ""}${deliveredAs ? `；deliveredAs=${deliveredAs}` : ""}`;
  return replayJson(ctx, summary, {
    fileRef,
    fileId,
    path,
    pathMode: ctx.parsedContent?.path_mode ?? ctx.parsedContent?.pathMode ?? null,
    deliveredAs,
    queued
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
    assetHandle: compactAssetHandleForReplay(ctx.parsedContent?.asset_handle),
    resourceId,
    targetId,
    mode: ctx.parsedContent?.mode ?? null,
    mimeType: ctx.parsedContent?.mime_type ?? ctx.parsedContent?.mimeType ?? null,
    sizeBytes: ctx.parsedContent?.size_bytes ?? ctx.parsedContent?.sizeBytes ?? null
  });
}

function compactDownloadHandle(ctx: Parameters<ToolResultCompactor>[0]) {
  const fileId = stringValue(ctx.parsedContent?.file_id ?? ctx.parsedContent?.fileId);
  const fileRef = stringValue(ctx.parsedContent?.file_ref ?? ctx.parsedContent?.fileRef);
  const sourceUrl = stringValue(ctx.parsedContent?.source_url ?? ctx.parsedContent?.sourceUrl);
  const resourceId = stringValue(ctx.parsedContent?.resource_id ?? ctx.parsedContent?.resourceId);
  const status = stringValue(ctx.parsedContent?.status);
  const summary = [
    `下载${status ? ` status=${status}` : "已返回"}`,
    fileId ? `file_id=${fileId}` : null,
    resourceId ? `resource_id=${resourceId}` : null,
    sourceUrl ? `来源 ${compactText(sourceUrl, 120)}` : null
  ].filter((item): item is string => Boolean(item)).join("；");
  return replayJson(ctx, summary, {
    fileId,
    fileRef,
    status,
    kind: ctx.parsedContent?.kind ?? null,
    sourceUrl,
    resourceId,
    groupFileId: ctx.parsedContent?.groupFileId ?? ctx.parsedContent?.group_file_id ?? null,
    targetId: ctx.parsedContent?.target_id ?? ctx.parsedContent?.targetId ?? null,
    mimeType: ctx.parsedContent?.mime_type ?? ctx.parsedContent?.mimeType ?? null,
    sizeBytes: ctx.parsedContent?.size_bytes ?? ctx.parsedContent?.sizeBytes ?? null,
    downloadedBytes: ctx.parsedContent?.downloaded_bytes ?? ctx.parsedContent?.downloadedBytes ?? null,
    totalBytes: ctx.parsedContent?.total_bytes ?? ctx.parsedContent?.totalBytes ?? null,
    percent: ctx.parsedContent?.percent ?? null,
    error: ctx.parsedContent?.error ?? null,
    assetHandle: compactAssetHandleForReplay(ctx.parsedContent?.asset_handle),
    nextActions: arrayValue(ctx.parsedContent?.next_actions)?.slice(0, 4) ?? [],
    handleCapabilities: arrayValue(ctx.parsedContent?.handle_capabilities)?.slice(0, 6) ?? []
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

function compactLocalFileItemForReplay(item: unknown): Record<string, unknown> {
  const record = objectValue(item);
  if (!record) {
    return { path: compactText(String(item ?? ""), 160) };
  }
  return {
    path: record.path ?? null,
    name: record.name ?? null,
    kind: record.kind ?? record.type ?? null,
    sizeBytes: record.sizeBytes ?? record.size_bytes ?? null,
    updatedAtMs: record.updatedAtMs ?? record.updated_at_ms ?? null
  };
}

function compactLocalSearchItemForReplay(item: unknown): Record<string, unknown> {
  const record = objectValue(item);
  if (!record) {
    return { text: compactText(String(item ?? ""), 160) };
  }
  return {
    path: record.path ?? null,
    name: record.name ?? null,
    kind: record.kind ?? record.type ?? null,
    line: record.line ?? record.lineNumber ?? null,
    text: stringValue(record.text) ? compactText(String(record.text), 180) : null
  };
}

function compactChatFileForReplay(item: unknown): Record<string, unknown> {
  const record = objectValue(item);
  if (!record) {
    return { fileRef: compactText(String(item ?? ""), 160) };
  }
  return {
    fileRef: record.asset_ref ?? record.file_ref ?? record.fileRef ?? null,
    fileId: record.file_id ?? record.fileId ?? null,
    kind: record.kind ?? null,
    origin: record.origin ?? null,
    sourceName: record.source_name ?? record.sourceName ?? null,
    mimeType: record.mime_type ?? record.mimeType ?? null,
    sizeBytes: record.size_bytes ?? record.sizeBytes ?? null,
    captionStatus: record.caption_status ?? record.captionStatus ?? null,
    caption: stringValue(record.caption) ? compactText(String(record.caption), 80) : null,
    createdAtMs: record.created_at_ms ?? record.createdAtMs ?? null,
    handle: compactFileHandleForReplay(record.handle)
  };
}

function compactMediaWorkspaceForReplay(item: unknown): Record<string, unknown> {
  const compacted = compactChatFileForReplay(item);
  const record = objectValue(item);
  return {
    ...compacted,
    caption: record && stringValue(record.caption) ? compactText(String(record.caption), 120) : compacted.caption
  };
}

function compactAudioSummaryForReplay(item: unknown): Record<string, unknown> {
  const record = objectValue(item);
  if (!record) {
    return { source: compactText(String(item ?? ""), 160) };
  }
  return {
    mediaId: record.mediaId ?? record.media_id ?? null,
    kind: record.kind ?? null,
    source: stringValue(record.source) ? compactText(String(record.source), 180) : null,
    transcriptionStatus: record.transcriptionStatus ?? record.transcription_status ?? null,
    transcriptionError: stringValue(record.transcriptionError ?? record.transcription_error)
      ? compactText(String(record.transcriptionError ?? record.transcription_error), 180)
      : null,
    transcription: stringValue(record.transcription)
      ? compactText(String(record.transcription), 360)
      : null
  };
}

function compactFileHandleForReplay(item: unknown): Record<string, unknown> | null {
  const record = objectValue(item);
  if (!record) {
    return null;
  }
  const file = objectValue(record.file);
  return {
    source: record.source ?? null,
    id: record.id ?? null,
    selector: record.selector ?? null,
    file: file
      ? {
          fileRef: file.asset_ref ?? file.file_ref ?? file.fileRef ?? null,
          fileId: file.file_id ?? file.fileId ?? null,
          path: file.path ?? file.chat_file_path ?? file.chatFilePath ?? null,
          name: file.name ?? file.source_name ?? file.sourceName ?? null,
          kind: file.kind ?? file.media_kind ?? file.mediaKind ?? null,
          mimeType: file.mime_type ?? file.mimeType ?? null,
          sizeBytes: file.size_bytes ?? file.sizeBytes ?? null
        }
      : null,
    capabilities: (arrayValue(record.capabilities) ?? [])
      .map(compactFileHandleCapabilityForReplay)
      .slice(0, 6),
    nextActions: arrayValue(record.next_actions)?.slice(0, 4) ?? []
  };
}

function compactAssetHandleForReplay(item: unknown): Record<string, unknown> | null {
  const record = objectValue(item);
  if (!record) {
    return null;
  }
  return {
    source: record.source ?? null,
    id: record.id ?? record.asset_id ?? null,
    assetId: record.asset_id ?? record.assetId ?? record.id ?? null,
    assetRef: record.asset_ref ?? record.assetRef ?? null,
    selector: record.selector ?? null,
    kind: record.kind ?? null,
    sourceName: record.source_name ?? record.sourceName ?? null,
    mimeType: record.mime_type ?? record.mimeType ?? null,
    sizeBytes: record.size_bytes ?? record.sizeBytes ?? null,
    capabilities: (arrayValue(record.capabilities) ?? [])
      .map(compactFileHandleCapabilityForReplay)
      .slice(0, 10),
    nextActions: arrayValue(record.next_actions)?.slice(0, 4) ?? []
  };
}

function compactFileHandleCapabilityForReplay(item: unknown): Record<string, unknown> {
  const record = objectValue(item);
  if (!record) {
    return { capability: compactText(String(item ?? ""), 80) };
  }
  return {
    capability: record.capability ?? null,
    tool: record.tool ?? null,
    available: record.available ?? null,
    args: record.args ?? null,
    requires: record.requires ?? null
  };
}

function countBy(items: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = stringValue(item[key]) ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function localMutationAction(toolName: string): string {
  if (toolName === "filesystem_write") return "写入";
  if (toolName === "filesystem_patch") return "修改";
  if (toolName === "filesystem_move") return "移动";
  if (toolName === "filesystem_delete") return "删除";
  if (toolName === "filesystem_mkdir") return "创建";
  return "更新";
}

function localMutationTargetLabel(toolName: string): string {
  return toolName === "filesystem_mkdir" ? "目录" : "本地文件";
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

function compactGroupAnnouncementDetail(ctx: Parameters<ToolResultCompactor>[0]) {
  const summary = stringValue(ctx.parsedContent?.summary)
    ?? "当前群公告原文片段已返回";
  return replayJson(ctx, summary, {
    groupResource: ctx.resource,
    announcementId: ctx.parsedContent?.announcementId ?? ctx.parsedContent?.announcement_id ?? null,
    title: ctx.parsedContent?.title ?? null,
    startLine: ctx.parsedContent?.startLine ?? ctx.parsedContent?.start_line ?? null,
    startChar: ctx.parsedContent?.startChar ?? ctx.parsedContent?.start_char ?? null,
    endLine: ctx.parsedContent?.endLine ?? ctx.parsedContent?.end_line ?? null,
    totalLines: ctx.parsedContent?.totalLines ?? ctx.parsedContent?.total_lines ?? null,
    nextStartLine: ctx.parsedContent?.nextStartLine ?? ctx.parsedContent?.next_start_line ?? null,
    nextStartChar: ctx.parsedContent?.nextStartChar ?? ctx.parsedContent?.next_start_char ?? null,
    lineTruncated: ctx.parsedContent?.lineTruncated ?? ctx.parsedContent?.line_truncated ?? null,
    charTruncated: ctx.parsedContent?.charTruncated ?? ctx.parsedContent?.char_truncated ?? null,
    content: compactText(stringValue(ctx.parsedContent?.content) ?? "", 2400)
  });
}

function compactMediaHandle(ctx: Parameters<ToolResultCompactor>[0]) {
  const summary = `${ctx.toolName} 已提供媒体上下文：${ctx.resource ? `${ctx.resource.kind}:${ctx.resource.id}` : "无资源句柄"}`;
  return replayJson(ctx, summary, {
    resource: ctx.resource,
    caption: ctx.parsedContent?.caption ?? null,
    workspace: (arrayValue(ctx.parsedContent?.workspace) ?? [])
      .map(compactMediaWorkspaceForReplay)
      .slice(0, 8),
    handles: (arrayValue(ctx.parsedContent?.handles) ?? [])
      .map(compactFileHandleForReplay)
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .slice(0, 8),
    handle: compactFileHandleForReplay(ctx.parsedContent?.handle),
    handleCapabilities: arrayValue(ctx.parsedContent?.handle_capabilities)
      ?.map(compactFileHandleCapabilityForReplay)
      .slice(0, 6) ?? [],
    audio: (arrayValue(ctx.parsedContent?.audio) ?? [])
      .map(compactAudioSummaryForReplay)
      .slice(0, 8),
    nextActions: arrayValue(ctx.parsedContent?.next_actions)?.slice(0, 4) ?? []
  });
}

function replayJson(
  ctx: Parameters<ToolResultCompactor>[0],
  summary: string,
  data?: Record<string, unknown>
) {
  const okOverride = data && typeof data.ok === "boolean" ? data.ok : null;
  const replayData = data
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "ok"))
    : undefined;
  return {
    summary,
    replayContent: JSON.stringify({
      ok: okOverride ?? !hasError(ctx),
      compacted: true,
      tool: ctx.toolName,
      ...(ctx.resource ? { resource: ctx.resource } : {}),
      summary,
      ...(replayData ? { data: replayData } : {}),
      ...(ctx.refetchHint ? { refetch_hint: ctx.refetchHint } : {})
    })
  };
}

function currentGroupLocator(ctx: ToolResultObservationContext): string | undefined {
  if (ctx.toolName === "view_current_group_info") return "info";
  if (ctx.toolName === "view_current_group_announcement") {
    const announcementId = stringValue(ctx.parsedContent?.announcementId ?? ctx.parsedContent?.announcement_id);
    const startLine = numberValue(ctx.parsedContent?.startLine ?? ctx.parsedContent?.start_line);
    const endLine = numberValue(ctx.parsedContent?.endLine ?? ctx.parsedContent?.end_line);
    return [
      "announcement",
      announcementId ? `id=${JSON.stringify(announcementId)}` : null,
      startLine && endLine ? `L${startLine}-L${endLine}` : null
    ].filter((item): item is string => Boolean(item)).join(" ");
  }
  if (ctx.toolName === "download_current_group_file") {
    const groupFileId = stringValue(ctx.parsedContent?.groupFileId ?? ctx.parsedContent?.group_file_id);
    const resourceId = stringValue(ctx.parsedContent?.resource_id ?? ctx.parsedContent?.resourceId);
    return [
      "file-download",
      groupFileId ? `group_file_id=${JSON.stringify(groupFileId)}` : null,
      resourceId ? `resource_id=${resourceId}` : null
    ].filter((item): item is string => Boolean(item)).join(" ");
  }
  const query = stringValue(ctx.parsedContent?.query);
  const limit = numberValue(ctx.parsedContent?.limit);
  return [
    ctx.toolName === "list_current_group_announcements" ? "announcements" : ctx.toolName === "list_current_group_files" ? "files" : "members",
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

import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import type { BuiltinToolContext } from "../core/shared.ts";
import { buildChatFileHandleResultFromContext } from "../core/chatFileHandle.ts";
import { downloadResourcePolicy, keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { projectToolResult, type JsonObject } from "../core/toolResultProjection.ts";
import type { DownloadRuntimeSnapshot } from "#services/workspace/downloadRuntime.ts";

export const resourceToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "list_live_resources",
        description: "列出当前可复用的 browser live_resource 和后台下载资源。live_resource 只表示正在运行的可继续操作句柄，不是工作区文件；终端资源请用 terminal_list。",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["all", "browser", "download"]
            }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.browser.enabled || config.chatFiles.enabled,
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  },
  {
    definition: {
      type: "function",
      function: {
        name: "start_download_resource",
        description: "从 HTTP/HTTPS URL 创建后台下载任务。下载结果会自动登记为 asset；任务较慢时会返回 resource_id，并在完成或失败后自动回调。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "绝对 HTTP/HTTPS 下载地址" },
            source_name: { type: "string", description: "可选文件名；只填写名称，不要填写路径" },
            kind: { type: "string", enum: ["image", "animated_image", "video", "audio", "file"] },
            concurrency: { type: "integer", minimum: 1, maximum: 16, description: "分段下载并发数，默认 4" },
            proxy: { type: "string", enum: ["auto", "direct"], description: "auto 使用浏览器代理配置，direct 强制直连；默认 auto" }
          },
          required: ["url"],
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.chatFiles.enabled,
    resultObservation: downloadResourcePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "read_download_resource",
        description: "读取后台下载资源状态。下载完成时会返回已登记的 asset_handle 和可继续处理的工具提示。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.chatFiles.enabled,
    resultObservation: downloadResourcePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "pause_download_resource",
        description: "暂停正在运行的下载并保留可恢复的分段进度。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.chatFiles.enabled,
    resultObservation: downloadResourcePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "resume_download_resource",
        description: "恢复已暂停或失败的下载；服务端支持 Range 和校验信息时会从 checkpoint 续传。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.chatFiles.enabled,
    resultObservation: downloadResourcePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "cancel_download_resource",
        description: "取消仍在后台运行的下载资源。已完成或已失败的下载不会被撤销。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.chatFiles.enabled,
    resultObservation: downloadResourcePolicy()
  }
];

export const resourceToolHandlers: Record<string, ToolHandler> = {
  async start_download_resource(_toolCall, args, context) {
    const sourceUrl = getStringArg(args, "url");
    const sourceName = getStringArg(args, "source_name");
    const kind = getStringArg(args, "kind") as "image" | "animated_image" | "video" | "audio" | "file" | undefined;
    const concurrency = getNumberArg(args, "concurrency");
    const proxy = getStringArg(args, "proxy") ?? "auto";
    if (!sourceUrl) {
      return JSON.stringify({ error: "url is required" });
    }
    if (proxy !== "auto" && proxy !== "direct") {
      return JSON.stringify({ error: "proxy must be auto or direct" });
    }
    if (kind && !["image", "animated_image", "video", "audio", "file"].includes(kind)) {
      return JSON.stringify({ error: "kind must be image, animated_image, video, audio or file" });
    }
    try {
      const snapshot = await context.downloadRuntime.start({
        sourceUrl,
        ...(sourceName ? { sourceName } : {}),
        ...(kind ? { kind } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
        origin: "url_download",
        ...(proxy === "auto" ? { proxyConsumer: "browser" } : {}),
        owner: {
          sessionId: context.lastMessage.sessionId,
          userId: context.lastMessage.userId,
          senderName: context.lastMessage.senderName
        },
        sourceContext: { requested_by_tool: "start_download_resource" }
      });
      return projectToolResult({
        toolName: "start_download_resource",
        canonical: await buildDownloadToolResult(snapshot, context),
        ...projectionArgs(args),
        projection: { initial: compactDownloadToolResult }
      });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async list_live_resources(_toolCall, args, context) {
    const type = typeof args === "object" && args && "type" in args
      ? String((args as { type: unknown }).type).trim()
      : "all";
    if (!["all", "browser", "download"].includes(type)) {
      return JSON.stringify({ error: "type must be all, browser or download" });
    }

    const includeBrowser = type === "all" || type === "browser";
    const includeDownload = type === "all" || type === "download";

    const pages = includeBrowser && context.config.browser.enabled
      ? await context.browserService.listPages()
      : { ok: true as const, pages: [] };
    const downloads = includeDownload && context.config.chatFiles.enabled
      ? context.downloadRuntime.list()
      : [];

    const resources = [
      ...pages.pages.map((item) => ({
        resource_id: item.resource_id,
        kind: "browser_page",
        status: item.status,
        title: item.title,
        description: item.description,
        summary: item.summary,
        createdAtMs: item.createdAtMs,
        lastAccessedAtMs: item.lastAccessedAtMs,
        expiresAtMs: item.expiresAtMs
      })),
      ...downloads.map((item) => ({
        resource_id: item.resource_id,
        kind: "download",
        status: item.status,
        title: item.source_name ?? item.source_url,
        description: item.source_url,
        summary: [
          `status=${item.status}`,
          item.percent != null ? `progress=${item.percent}%` : `bytes=${item.downloaded_bytes}`,
          item.file_ref ? `asset_ref=${item.file_ref}` : null,
          item.error ? `error=${item.error}` : null
        ].filter((part): part is string => Boolean(part)).join("；"),
        createdAtMs: item.created_at_ms,
        lastAccessedAtMs: item.updated_at_ms,
        expiresAtMs: null
      }))
    ].sort((left, right) => right.lastAccessedAtMs - left.lastAccessedAtMs);

    return projectToolResult({
      toolName: "list_live_resources",
      canonical: {
        ok: true,
        type,
        live_resources: resources
      },
      ...projectionArgs(args),
      projection: {
        initial: (canonical) => canonical
      }
    });
  },

  async read_download_resource(_toolCall, args, context) {
    const resourceId = getStringArg(args, "resource_id");
    if (!resourceId) {
      return JSON.stringify({ error: "resource_id is required" });
    }
    const snapshot = context.downloadRuntime.read(resourceId);
    if (!snapshot) {
      return JSON.stringify({ error: "download resource not found", resource_id: resourceId });
    }
    return projectToolResult({
      toolName: "read_download_resource",
      canonical: await buildDownloadToolResult(snapshot, context),
      ...projectionArgs(args),
      projection: {
        initial: compactDownloadToolResult
      }
    });
  },

  async pause_download_resource(_toolCall, args, context) {
    return mutateDownloadResource("pause_download_resource", "pause", args, context);
  },

  async resume_download_resource(_toolCall, args, context) {
    return mutateDownloadResource("resume_download_resource", "resume", args, context);
  },

  async cancel_download_resource(_toolCall, args, context) {
    const resourceId = getStringArg(args, "resource_id");
    if (!resourceId) {
      return JSON.stringify({ error: "resource_id is required" });
    }
    const snapshot = await context.downloadRuntime.cancel(resourceId);
    if (!snapshot) {
      return JSON.stringify({ error: "download resource not found", resource_id: resourceId });
    }
    return projectToolResult({
      toolName: "cancel_download_resource",
      canonical: await buildDownloadToolResult(snapshot, context),
      ...projectionArgs(args),
      projection: {
        initial: compactDownloadToolResult
      }
    });
  }
};

async function mutateDownloadResource(
  toolName: "pause_download_resource" | "resume_download_resource",
  operation: "pause" | "resume",
  args: unknown,
  context: BuiltinToolContext
) {
  const resourceId = getStringArg(args, "resource_id");
  if (!resourceId) {
    return JSON.stringify({ error: "resource_id is required" });
  }
  const snapshot = await context.downloadRuntime[operation](resourceId);
  if (!snapshot) {
    return JSON.stringify({ error: "download resource not found", resource_id: resourceId });
  }
  return projectToolResult({
    toolName,
    canonical: await buildDownloadToolResult(snapshot, context),
    ...projectionArgs(args),
    projection: { initial: compactDownloadToolResult }
  });
}

async function buildDownloadToolResult(snapshot: DownloadRuntimeSnapshot, context: BuiltinToolContext): Promise<JsonObject> {
  const file = snapshot.file_id ? await context.chatFileStore.getFile(snapshot.file_id) : null;
  const fileHandle = file ? buildChatFileHandleResultFromContext(file, context) : null;
  return {
    ...snapshot,
    ...(fileHandle ?? {})
  } as unknown as JsonObject;
}

function compactDownloadToolResult(canonical: JsonObject): JsonObject {
  return {
    resource_id: canonical.resource_id,
    status: canonical.status,
    phase: canonical.phase,
    retryable: canonical.retryable,
    percent: canonical.percent,
    downloaded_bytes: canonical.downloaded_bytes,
    total_bytes: canonical.total_bytes,
    file_ref: canonical.file_ref,
    asset_handle: canonical.asset_handle,
    mime_type: canonical.mime_type,
    error: canonical.error,
    next_actions: canonical.next_actions
  };
}

function projectionArgs(args: unknown): { args?: Record<string, unknown> } {
  return args && typeof args === "object" ? { args: args as Record<string, unknown> } : {};
}

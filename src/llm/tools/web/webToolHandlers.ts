import type { LlmToolExecutionResult } from "../../llmClient.ts";
import type { ToolHandler } from "../core/shared.ts";
import { getBooleanArg, getNumberArg, getStringArg, getStringArrayArg } from "../core/toolArgHelpers.ts";
import { mapWorkspaceFileToView } from "../core/workspaceFileView.ts";
import { nextAction, withNextActions, type ToolNextAction } from "../core/toolNextActions.ts";
import type { BrowserActionTarget, BrowserCoordinate } from "#services/web/browser/types.ts";
import { isBrowserInteractionAction } from "#services/web/browser/types.ts";
import {
  DerivedObservationReader,
  imageCaptionMapFromDerivedObservations
} from "#llm/derivations/derivedObservationReader.ts";

export const webToolHandlers: Record<string, ToolHandler> = {
  async ground_with_google_search(_toolCall, args, context) {
    const query = getStringArg(args, "query");
    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }

    try {
      return JSON.stringify(await context.searchService.searchGoogleGrounding(query));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async search_with_iqs_lite_advanced(_toolCall, args, context) {
    const query = getStringArg(args, "query");
    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }

    try {
      return JSON.stringify(await context.searchService.searchAliyunIqsLiteAdvanced(query, {
        numResults: getNumberArg(args, "num_results"),
        includeSites: getStringArrayArg(args, "include_sites"),
        excludeSites: getStringArrayArg(args, "exclude_sites"),
        startPublishedDate: getStringArg(args, "start_published_date") || undefined,
        endPublishedDate: getStringArg(args, "end_published_date") || undefined,
        timeRange: getStringArg(args, "time_range") || undefined,
        includeMainText: getBooleanArg(args, "include_main_text"),
        includeMarkdownText: getBooleanArg(args, "include_markdown_text")
      }));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async open_page(_toolCall, args, context) {
    const refId = getStringArg(args, "ref_id");
    const url = getStringArg(args, "url");
    const description = getStringArg(args, "description");
    const line = getNumberArg(args, "line");

    if (!refId && !url) {
      return JSON.stringify({ error: "Provide exactly one of ref_id or url" });
    }

    try {
      const result = await context.browserService.openPage({
        ...(refId ? { refId } : {}),
        ...(url ? { url } : {}),
        ...(description ? { description } : {}),
        ...(line === undefined ? {} : { line }),
        ...(context.lastMessage.sessionId ? { ownerSessionId: context.lastMessage.sessionId } : {})
      });
      return JSON.stringify(withNextActions(result as unknown as Record<string, unknown>, browserPageNextActions(String((result as { resource_id?: string }).resource_id ?? ""))));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async inspect_page(_toolCall, args, context) {
    const resourceId = getStringArg(args, "resource_id");
    const line = getNumberArg(args, "line");
    const pattern = getStringArg(args, "pattern");
    if (!resourceId) {
      return JSON.stringify({ error: "resource_id is required" });
    }

    try {
      const result = await context.browserService.inspectPage({
        resourceId,
        ...(line === undefined ? {} : { line }),
        ...(pattern ? { pattern } : {})
      });
      return JSON.stringify(withNextActions(result as unknown as Record<string, unknown>, browserInspectNextActions(resourceId)));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async interact_with_page(_toolCall, args, context) {
    const resourceId = getStringArg(args, "resource_id");
    const action = getStringArg(args, "action");
    const targetId = getNumberArg(args, "target_id");
    const target = getBrowserActionTarget(args, "target");
    const coordinate = getBrowserCoordinate(args, "coordinate");
    const text = getRawStringArg(args, "text");
    const value = getStringArg(args, "value");
    const key = getStringArg(args, "key");
    const waitMs = getNumberArg(args, "wait_ms");
    const line = getNumberArg(args, "line");
    if (!resourceId) {
      return JSON.stringify({ error: "resource_id is required" });
    }
    if (!action) {
      return JSON.stringify({ error: "action is required" });
    }
    if (!isBrowserInteractionAction(action)) {
      return JSON.stringify({ error: `unsupported action: ${action}` });
    }

    try {
      const filePaths = resolveWorkspaceFilePaths(context, getStringArrayArg(args, "file_paths"));
      return JSON.stringify(await context.browserService.interactWithPage({
        resourceId,
        action,
        ...(targetId === undefined ? {} : { targetId: Number(targetId) }),
        ...(target ? { target } : {}),
        ...(coordinate ? { coordinate } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(value ? { value } : {}),
        ...(key ? { key } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(waitMs === undefined ? {} : { waitMs: Number(waitMs) }),
        ...(line === undefined ? {} : { line })
      }));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async close_page(_toolCall, args, context) {
    const resourceId = getStringArg(args, "resource_id");
    if (!resourceId) {
      return JSON.stringify({ error: "resource_id is required" });
    }

    try {
      return JSON.stringify(await context.browserService.closePage(resourceId));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async capture_screenshot(_toolCall, args, context) {
    const resourceId = getStringArg(args, "resource_id");
    const targetId = getNumberArg(args, "target_id");
    if (!resourceId) {
      return JSON.stringify({ error: "resource_id is required" });
    }
    try {
      const result = targetId === undefined
        ? await context.browserService.capturePageScreenshot(resourceId)
        : await context.browserService.captureElementScreenshot(resourceId, Number(targetId));
      return buildScreenshotToolResult(result.fileId, result, context);
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async download_asset(_toolCall, args, context) {
    const url = getStringArg(args, "url");
    const resourceId = getStringArg(args, "resource_id");
    const targetId = getNumberArg(args, "target_id");
    const sourceName = getStringArg(args, "source_name");
    const kind = getStringArg(args, "kind") as "image" | "animated_image" | "video" | "audio" | "file" | undefined;
    if (Boolean(url) === Boolean(resourceId)) {
      return JSON.stringify({ error: "provide exactly one of url or resource_id" });
    }
    if (targetId !== undefined && !resourceId) {
      return JSON.stringify({ error: "target_id requires resource_id" });
    }
    try {
      const result = await context.browserService.downloadAsset({
        ...(url ? { url } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(targetId !== undefined ? { targetId } : {}),
        ...(sourceName ? { sourceName } : {}),
        ...(kind ? { kind } : {})
      });
      const file = await context.chatFileStore.getFile(result.file_id);
      return JSON.stringify(withNextActions({
        ok: true,
        ...(file ? mapWorkspaceFileToView(file) : { file_id: result.file_id }),
        kind: result.kind,
        mime_type: file?.mimeType ?? result.mimeType,
        size_bytes: file?.sizeBytes ?? result.sizeBytes,
        source_url: result.source_url,
        resource_id: result.resource_id,
        target_id: result.target_id
      }, downloadedFileNextActions({
        fileId: result.file_id,
        ...(file?.fileRef ? { fileRef: file.fileRef } : {}),
        kind: result.kind
      })));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async list_browser_profiles(_toolCall, _args, context) {
    try {
      return JSON.stringify(await context.browserService.listProfiles());
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async inspect_browser_profile(_toolCall, args, context) {
    const profileId = getStringArg(args, "profile_id");
    if (!profileId) {
      return JSON.stringify({ error: "profile_id is required" });
    }
    try {
      return JSON.stringify(await context.browserService.inspectProfile(profileId));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async save_browser_profile(_toolCall, args, context) {
    const profileId = getStringArg(args, "profile_id");
    if (!profileId) {
      return JSON.stringify({ error: "profile_id is required" });
    }
    try {
      return JSON.stringify(await context.browserService.saveProfile(profileId));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async clear_browser_profile(_toolCall, args, context) {
    const profileId = getStringArg(args, "profile_id");
    if (!profileId) {
      return JSON.stringify({ error: "profile_id is required" });
    }
    try {
      return JSON.stringify(await context.browserService.clearProfile(profileId));
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
};

function browserPageNextActions(resourceId: string): ToolNextAction[] {
  if (!resourceId) {
    return [];
  }
  return [
    nextAction("inspect_page", "查看页面文本、链接和可交互元素", { resource_id: resourceId }),
    nextAction("interact_with_page", "点击、输入、上传或提交页面元素", { resource_id: resourceId }),
    nextAction("capture_screenshot", "查看页面或局部元素截图", { resource_id: resourceId }),
    nextAction("download_asset", "保存页面中的图片、视频或链接资源", { resource_id: resourceId })
  ];
}

function browserInspectNextActions(resourceId: string): ToolNextAction[] {
  return [
    nextAction("interact_with_page", "基于 inspect_page 返回的 target_id 或语义目标执行交互", { resource_id: resourceId }),
    nextAction("capture_screenshot", "需要视觉确认时截图，可带 target_id 截局部", { resource_id: resourceId }),
    nextAction("download_asset", "保存 inspect_page 中发现的媒体或链接资源", { resource_id: resourceId })
  ];
}

function downloadedFileNextActions(input: {
  fileId: string;
  fileRef?: string | null;
  kind: string;
}): ToolNextAction[] {
  const selector = input.fileRef ?? input.fileId;
  const actions: ToolNextAction[] = [];
  if (input.kind === "image" || input.kind === "animated_image" || input.kind === "video" || input.kind === "audio") {
    actions.push(nextAction("chat_file_view_media", "查看下载得到的媒体内容", { media_ids: [input.fileId] }));
  }
  actions.push(nextAction("chat_file_send_to_chat", "把下载得到的文件发送到当前聊天", { file_ref: selector }));
  return actions;
}

function getBrowserActionTarget(args: unknown, key: string): BrowserActionTarget | undefined {
  if (typeof args !== "object" || !args || !(key in args)) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "object" || !value) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const target: BrowserActionTarget = {
    ...(normalizeOptionalString(record.role) ? { role: normalizeOptionalString(record.role) } : {}),
    ...(normalizeOptionalString(record.name) ? { name: normalizeOptionalString(record.name) } : {}),
    ...(normalizeOptionalString(record.text) ? { text: normalizeOptionalString(record.text) } : {}),
    ...(normalizeOptionalString(record.tag) ? { tag: normalizeOptionalString(record.tag) } : {}),
    ...(normalizeOptionalString(record.type) ? { type: normalizeOptionalString(record.type) } : {}),
    ...(normalizeOptionalString(record.href_contains) ? { hrefContains: normalizeOptionalString(record.href_contains) } : {}),
    ...(normalizeOptionalIndex(record.index) === undefined ? {} : { index: normalizeOptionalIndex(record.index) })
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

function getBrowserCoordinate(args: unknown, key: string): BrowserCoordinate | undefined {
  if (typeof args !== "object" || !args || !(key in args)) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "object" || !value) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  return {
    x,
    y
  };
}

function getRawStringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || !args || !(key in args)) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  if (value == null) {
    return "";
  }
  return typeof value === "string" ? value : String(value);
}

function resolveWorkspaceFilePaths(
  context: Parameters<ToolHandler>[2],
  filePaths: string[] | undefined
): string[] | undefined {
  if (!filePaths) {
    return undefined;
  }
  return filePaths.map((path) => context.localFileService.resolvePath(path).absolutePath);
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function normalizeOptionalIndex(value: unknown): number | undefined {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : undefined;
}

async function buildScreenshotToolResult(
  imageId: string,
  result: unknown,
  context: Parameters<ToolHandler>[2]
): Promise<LlmToolExecutionResult | string> {
  const prepared = await context.mediaVisionService.prepareFileForModel(imageId).catch(() => null);
  const file = await context.chatFileStore.getFile(imageId).catch(() => null);
  const contentPayload = file
    ? {
        ok: true,
        ...mapWorkspaceFileToView(file),
        mode: typeof result === "object" && result && "mode" in result ? (result as { mode?: unknown }).mode : null,
        resource_id: typeof result === "object" && result && "resource_id" in result ? (result as { resource_id?: unknown }).resource_id : null,
        profile_id: typeof result === "object" && result && "profile_id" in result ? (result as { profile_id?: unknown }).profile_id : null,
        target_id: typeof result === "object" && result && "target_id" in result ? (result as { target_id?: unknown }).target_id : null
      }
    : result;
  if (!prepared) {
    return JSON.stringify(contentPayload);
  }
  const caption = imageCaptionMapFromDerivedObservations(await new DerivedObservationReader({
    chatFileStore: context.chatFileStore
  }).read({ chatFileIds: [imageId] }).catch(() => [])).get(imageId);
  return {
    content: JSON.stringify(contentPayload),
    supplementalMessages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: `以下截图来自浏览器工具，请结合它继续完成当前页面任务。file_id=${file?.fileId ?? imageId}${file?.fileRef ? ` file_ref=${file.fileRef}` : ""}${caption ? ` caption=${caption}` : ""}`
        },
        {
          type: "image_url",
          image_url: {
            url: prepared.inputUrl
          }
        }
      ]
    }]
  };
}

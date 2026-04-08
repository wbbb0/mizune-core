import type { LlmToolExecutionResult } from "../../llmClient.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getBooleanArg, getNumberArg, getStringArg, getStringArrayArg } from "../core/toolArgHelpers.ts";
import { mapWorkspaceFileToView } from "../core/workspaceFileView.ts";
import type { BrowserActionTarget, BrowserCoordinate } from "#services/web/browser/types.ts";
import { isBrowserInteractionAction } from "#services/web/browser/types.ts";

const isGoogleSearchToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.search.googleGrounding.enabled;
const isAliyunIqsToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.search.aliyunIqs.enabled;
const isBrowserToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.browser.enabled;

export const webToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "ground_with_google_search",
        description: "只在答案依赖最新外部网页信息时使用。对单个 query 做 Google grounding 搜索，返回摘要和可继续打开的 ref_ids。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isGoogleSearchToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "search_with_iqs_lite_advanced",
        description: "需要最新外部网页信息、但想要更可控的检索时使用。搜索阿里云 IQS LiteAdvanced，返回排序后的 ref_ids 和摘要。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            num_results: { type: "integer", minimum: 1, maximum: 50 },
            include_sites: { type: "array", items: { type: "string" }, maxItems: 100 },
            exclude_sites: { type: "array", items: { type: "string" }, maxItems: 100 },
            start_published_date: { type: "string", description: "格式 YYYY-MM-DD" },
            end_published_date: { type: "string", description: "格式 YYYY-MM-DD" },
            time_range: { type: "string" },
            include_main_text: { type: "boolean" },
            include_markdown_text: { type: "boolean" }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isAliyunIqsToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "list_browser_pages",
        description: "列出最近已知的浏览器页面 resources。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "open_page",
        description: "根据搜索 ref_id 或直接 URL 打开页面，返回 resource_id、可读文本、链接和可交互元素。开启新页面资源时应尽量提供 description，说明这个页面后续要做什么。",
        parameters: {
          type: "object",
          properties: {
            ref_id: { type: "string" },
            url: { type: "string" },
            description: { type: "string", description: "给这个页面资源的用途说明，便于后续复用时识别。" },
            line: { type: "integer", minimum: 1 }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "inspect_page",
        description: "按 resource_id 查看已打开页面，可跳到指定行或按 pattern 查找。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            line: { type: "integer", minimum: 1 },
            pattern: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "interact_with_page",
        description: "按 resource_id 操作当前页面。文本输入用 action=type 加 text；文件上传用 action=upload 加 file_paths（工作区相对路径）；优先使用 target_id，也可用 target 按 role/name/text/tag/type 语义定位；遇到 iframe 或元素定位失败时，可对 click/hover 传 coordinate.x 与 coordinate.y 做视口坐标操作。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            action: {
              type: "string",
              enum: ["click", "type", "upload", "select", "hover", "press", "check", "uncheck", "submit", "scroll_down", "scroll_up", "wait", "go_back", "go_forward", "reload"]
            },
            target_id: { type: "integer", minimum: 1 },
            target: {
              type: "object",
              properties: {
                role: { type: "string" },
                name: { type: "string" },
                text: { type: "string" },
                tag: { type: "string" },
                type: { type: "string" },
                href_contains: { type: "string" },
                index: { type: "integer", minimum: 1 }
              },
              additionalProperties: false
            },
            coordinate: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" }
              },
              required: ["x", "y"],
              additionalProperties: false
            },
            text: { type: "string", description: "action=type 时要输入的文本，保留空格与换行。" },
            value: { type: "string", description: "action=select 时的 option value；未提供时可回退到 text。" },
            key: { type: "string" },
            file_paths: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "action=upload 时要上传的工作区相对路径，可传多个。"
            },
            wait_ms: { type: "integer", minimum: 1 },
            line: { type: "integer", minimum: 1 }
          },
          required: ["resource_id", "action"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "close_page",
        description: "按 resource_id 关闭已打开页面。",
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
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "capture_page_screenshot",
        description: "对当前已打开页面截图，返回截图对应的 workspace file_id / file_ref，并把截图附到下一轮视觉上下文里。",
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
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "capture_element_screenshot",
        description: "按 target_id 对页面元素截图，适合验证码、登录框或局部区域。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            target_id: { type: "integer", minimum: 1 }
          },
          required: ["resource_id", "target_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "download_asset",
        description: "把远程链接或当前网页元素对应的图片、视频、音频、文件下载进工作区；支持直接给 url，也支持给 resource_id 加 target_id。成功后返回 workspace file_id / file_ref / workspace_path。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            resource_id: { type: "string" },
            target_id: { type: "integer", minimum: 1 },
            source_name: { type: "string" },
            kind: {
              type: "string",
              enum: ["image", "animated_image", "video", "audio", "file"]
            }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "list_browser_profiles",
        description: "列出当前实例中可用的浏览器持久化 profile。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "inspect_browser_profile",
        description: "查看一个浏览器 profile 的元数据和 origin 列表，不返回敏感 cookie 内容。",
        parameters: {
          type: "object",
          properties: {
            profile_id: { type: "string" }
          },
          required: ["profile_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "save_browser_profile",
        description: "立即保存当前浏览器 profile 的 cookies/localStorage/sessionStorage。",
        parameters: {
          type: "object",
          properties: {
            profile_id: { type: "string" }
          },
          required: ["profile_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "clear_browser_profile",
        description: "清空一个浏览器 profile 的持久化状态，用于重新登录。",
        parameters: {
          type: "object",
          properties: {
            profile_id: { type: "string" }
          },
          required: ["profile_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  }
];

export const webToolHandlers: Record<string, ToolHandler> = {
  async list_browser_pages(_toolCall, _args, context) {
    try {
      return JSON.stringify(await context.browserService.listPages());
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

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
      return JSON.stringify(await context.browserService.openPage({
        ...(refId ? { refId } : {}),
        ...(url ? { url } : {}),
        ...(description ? { description } : {}),
        ...(line === undefined ? {} : { line }),
        ...(context.lastMessage.sessionId ? { ownerSessionId: context.lastMessage.sessionId } : {})
      }));
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
      return JSON.stringify(await context.browserService.inspectPage({
        resourceId,
        ...(line === undefined ? {} : { line }),
        ...(pattern ? { pattern } : {})
      }));
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

  async capture_page_screenshot(_toolCall, args, context) {
    const resourceId = getStringArg(args, "resource_id");
    if (!resourceId) {
      return JSON.stringify({ error: "resource_id is required" });
    }
    try {
      const result = await context.browserService.capturePageScreenshot(resourceId);
      return buildScreenshotToolResult(result.fileId, result, context);
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async capture_element_screenshot(_toolCall, args, context) {
    const resourceId = getStringArg(args, "resource_id");
    const targetId = getNumberArg(args, "target_id");
    if (!resourceId) {
      return JSON.stringify({ error: "resource_id is required" });
    }
    if (targetId === undefined) {
      return JSON.stringify({ error: "target_id is required" });
    }
    try {
      const result = await context.browserService.captureElementScreenshot(resourceId, Number(targetId));
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
      const file = await context.mediaWorkspace.getFile(result.file_id);
      return JSON.stringify({
        ok: true,
        ...(file ? mapWorkspaceFileToView(file) : { file_id: result.file_id }),
        kind: result.kind,
        mime_type: file?.mimeType ?? result.mimeType,
        size_bytes: file?.sizeBytes ?? result.sizeBytes,
        source_url: result.source_url,
        resource_id: result.resource_id,
        target_id: result.target_id
      });
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
  return filePaths.map((path) => context.workspaceService.resolvePath(path).absolutePath);
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
  const file = await context.mediaWorkspace.getFile(imageId).catch(() => null);
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
  const caption = (await context.mediaCaptionService.getCaptionMap([imageId]).catch(() => new Map<string, string>())).get(imageId);
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

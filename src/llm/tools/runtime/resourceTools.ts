import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";

export const resourceToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "list_live_resources",
        description: "列出当前可复用的 browser live_resource。live_resource 只表示正在运行的可继续操作句柄，不是工作区文件；终端资源请用 terminal_list。",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["all", "browser"]
            }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.browser.enabled
  }
];

export const resourceToolHandlers: Record<string, ToolHandler> = {
  async list_live_resources(_toolCall, args, context) {
    const type = typeof args === "object" && args && "type" in args
      ? String((args as { type: unknown }).type).trim()
      : "all";
    if (!["all", "browser"].includes(type)) {
      return JSON.stringify({ error: "type must be all or browser" });
    }

    const includeBrowser = type === "all" || type === "browser";

    const pages = includeBrowser && context.config.browser.enabled
      ? await context.browserService.listPages()
      : { ok: true as const, pages: [] };

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
      }))
    ].sort((left, right) => right.lastAccessedAtMs - left.lastAccessedAtMs);

    return JSON.stringify({
      ok: true,
      type,
      live_resources: resources
    });
  }
};

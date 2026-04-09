import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";

export const resourceToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "list_live_resources",
        description: "列出当前可复用的 live_resource。可用 type 过滤 browser 或 shell；live_resource 只表示正在运行的可继续操作句柄，不是工作区文件。",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["all", "browser", "shell"]
            }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.browser.enabled || config.shell.enabled
  }
];

export const resourceToolHandlers: Record<string, ToolHandler> = {
  async list_live_resources(_toolCall, args, context) {
    const type = typeof args === "object" && args && "type" in args
      ? String((args as { type: unknown }).type).trim()
      : "all";
    if (!["all", "browser", "shell"].includes(type)) {
      return JSON.stringify({ error: "type must be all, browser, or shell" });
    }

    const includeBrowser = type === "all" || type === "browser";
    const includeShell = type === "all" || type === "shell";

    const [pages, shellSessions] = await Promise.all([
      includeBrowser && context.config.browser.enabled
        ? context.browserService.listPages()
        : Promise.resolve({ ok: true as const, pages: [] }),
      includeShell && context.config.shell.enabled
        ? context.shellRuntime.listSessionResources()
        : Promise.resolve([])
    ]);

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
      ...shellSessions.map((item) => ({
        resource_id: item.resource_id,
        kind: "shell_session",
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

import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";

export const resourceToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "list_runtime_resources",
        description: "列出当前可复用的运行时 resources，包含 browser 页面与 shell 会话。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.browser.enabled || config.shell.enabled
  }
];

export const resourceToolHandlers: Record<string, ToolHandler> = {
  async list_runtime_resources(_toolCall, _args, context) {
    const [pages, shellSessions] = await Promise.all([
      context.config.browser.enabled
        ? context.browserService.listPages()
        : Promise.resolve({ ok: true as const, pages: [] }),
      context.config.shell.enabled
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
      resources
    });
  }
};

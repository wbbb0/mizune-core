import type { Logger } from "pino";
import type { ShellRuntime } from "#services/shell/runtime.ts";
import type { BrowserService } from "#services/web/browser/browserService.ts";
import type { DownloadRuntime } from "#services/workspace/downloadRuntime.ts";
import type { ToolLoopCheckpointObservation } from "#llm/prompts/tool-loop-checkpoint.prompt.ts";

export async function collectToolLoopCheckpointResourceLines(input: {
  observations: ToolLoopCheckpointObservation[];
  shellRuntime: Pick<ShellRuntime, "listSessionResources">;
  browserService: Pick<BrowserService, "listPages">;
  downloadRuntime: Pick<DownloadRuntime, "read">;
  logger: Logger;
  sessionId: string;
  assertCurrent: () => void;
}): Promise<string[]> {
  const resources = uniqueReferencedResources(input.observations);
  if (resources.length === 0) {
    return [];
  }
  input.assertCurrent();
  const shellIds = new Set(resources.filter((item) => item.kind === "shell_session").map((item) => item.id));
  const browserIds = new Set(resources.filter((item) => item.kind === "browser_page").map((item) => item.id));
  const downloadIds = new Set(resources.filter((item) => item.kind === "download").map((item) => item.id));
  const [shellResult, browserResult] = await Promise.allSettled([
    shellIds.size > 0 ? input.shellRuntime.listSessionResources() : Promise.resolve([]),
    browserIds.size > 0 ? input.browserService.listPages() : Promise.resolve({ ok: true as const, pages: [] })
  ]);
  input.assertCurrent();

  const lines: string[] = [];
  if (shellIds.size > 0) {
    if (shellResult.status === "rejected") {
      input.logger.warn({ sessionId: input.sessionId, error: String(shellResult.reason) }, "tool_loop_checkpoint_shell_refresh_failed");
      lines.push(...Array.from(shellIds, (id) => `终端 ${id}：状态暂时无法刷新`));
    } else {
      const active = new Map(shellResult.value.map((item) => [item.resource_id, item]));
      for (const id of shellIds) {
        const item = active.get(id);
        lines.push(item
          ? `终端 ${id}：仍在运行${item.title ? `（${item.title}）` : ""}`
          : `终端 ${id}：当前未运行或已经结束`);
      }
    }
  }

  if (browserIds.size > 0) {
    if (browserResult.status === "rejected") {
      input.logger.warn({ sessionId: input.sessionId, error: String(browserResult.reason) }, "tool_loop_checkpoint_browser_refresh_failed");
      lines.push(...Array.from(browserIds, (id) => `浏览器页面 ${id}：状态暂时无法刷新`));
    } else {
      const active = new Map(browserResult.value.pages.map((item) => [item.resource_id, item]));
      for (const id of browserIds) {
        const item = active.get(id);
        lines.push(item
          ? `浏览器页面 ${id}：仍处于活动状态${item.title ? `（${item.title}）` : ""}`
          : `浏览器页面 ${id}：当前未保持活动`);
      }
    }
  }

  for (const id of downloadIds) {
    input.assertCurrent();
    try {
      const item = input.downloadRuntime.read(id);
      input.assertCurrent();
      if (!item) {
        lines.push(`下载 ${id}：当前记录不存在或已经过期`);
        continue;
      }
      const progress = item.percent == null ? "" : `，进度 ${formatPercent(item.percent)}`;
      const error = item.error ? `，错误：${item.error}` : "";
      lines.push(`下载 ${id}：${formatDownloadStatus(item.status, item.phase)}${progress}${error}`);
    } catch (error) {
      input.assertCurrent();
      input.logger.warn({ sessionId: input.sessionId, resourceId: id, error: String(error) }, "tool_loop_checkpoint_download_refresh_failed");
      lines.push(`下载 ${id}：状态暂时无法刷新`);
    }
  }
  return lines;
}

function uniqueReferencedResources(observations: ToolLoopCheckpointObservation[]): Array<{
  kind: "shell_session" | "browser_page" | "download";
  id: string;
}> {
  const resources = new Map<string, { kind: "shell_session" | "browser_page" | "download"; id: string }>();
  for (const observation of observations) {
    const rawId = observation.resource?.id.trim();
    if (!rawId) {
      continue;
    }
    const downloadId = rawId.startsWith("download:")
      ? rawId.slice("download:".length).trim()
      : rawId;
    const kind = downloadId.startsWith("res_download_")
      ? "download"
      : observation.resource?.kind === "shell_session"
        ? "shell_session"
        : observation.resource?.kind === "browser_page"
          ? "browser_page"
          : null;
    if (!kind) {
      continue;
    }
    const id = kind === "download" ? downloadId : rawId;
    resources.set(`${kind}:${id}`, { kind, id });
  }
  return Array.from(resources.values());
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, value)).toFixed(value < 10 ? 1 : 0)}%`;
}

function formatDownloadStatus(status: string, phase: string): string {
  const statusLabel: Record<string, string> = {
    running: "仍在运行",
    paused: "已暂停",
    completed: "已完成",
    failed: "已失败",
    cancelled: "已取消"
  };
  const phaseLabel: Record<string, string> = {
    queued: "排队",
    probing: "探测",
    transferring: "传输",
    finalizing: "收尾",
    importing: "导入"
  };
  return `${statusLabel[status] ?? status}（${phaseLabel[phase] ?? phase}阶段）`;
}

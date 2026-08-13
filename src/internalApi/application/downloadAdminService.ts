import type { InternalApiDownloadDeps } from "../types.ts";
import type { ParsedDownloadParams, ParsedDownloadStartBody } from "../routeSupport.ts";

export function listDownloads(deps: InternalApiDownloadDeps) {
  return { tasks: deps.downloadRuntime.list() };
}

export async function startDownload(deps: InternalApiDownloadDeps, body: ParsedDownloadStartBody) {
  return deps.downloadRuntime.start({
    sourceUrl: body.url,
    ...(body.sourceName ? { sourceName: body.sourceName } : {}),
    ...(body.kind ? { kind: body.kind } : {}),
    ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}),
    ...(body.proxy === "auto" ? { proxyConsumer: "browser" } : {}),
    origin: "url_download",
    sourceContext: { requested_by: "webui" },
    foregroundWaitMs: 0
  });
}

export function readDownload(deps: InternalApiDownloadDeps, params: ParsedDownloadParams) {
  return deps.downloadRuntime.read(params.resourceId);
}

export function pauseDownload(deps: InternalApiDownloadDeps, params: ParsedDownloadParams) {
  return deps.downloadRuntime.pause(params.resourceId);
}

export function resumeDownload(deps: InternalApiDownloadDeps, params: ParsedDownloadParams) {
  return deps.downloadRuntime.resume(params.resourceId);
}

export function cancelDownload(deps: InternalApiDownloadDeps, params: ParsedDownloadParams) {
  return deps.downloadRuntime.cancel(params.resourceId);
}

export function removeDownload(deps: InternalApiDownloadDeps, params: ParsedDownloadParams) {
  return deps.downloadRuntime.remove(params.resourceId);
}

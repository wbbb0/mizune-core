const EXPECTED_CONTENT_TYPES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\.(?:m?js)$/i, ["application/javascript", "text/javascript"]],
  [/\.css$/i, ["text/css"]],
  [/\.html?$/i, ["text/html"]],
  [/\.(?:json|webmanifest)$/i, ["application/json", "application/manifest+json"]],
  [/\.svg$/i, ["image/svg+xml"]],
  [/\.png$/i, ["image/png"]],
  [/\.webp$/i, ["image/webp"]],
  [/\.ico$/i, ["image/x-icon", "image/vnd.microsoft.icon"]]
];

export function isPrecacheResponseAllowed(
  request: Pick<Request, "url">,
  response: Pick<Response, "status" | "redirected" | "headers">
): boolean {
  if (response.status < 200 || response.status >= 300 || response.redirected) {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  const expected = EXPECTED_CONTENT_TYPES.find(([pattern]) => pattern.test(pathname));
  if (!expected) {
    return true;
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(contentType && expected[1].includes(contentType));
}

export const precacheResponseValidationPlugin: WorkboxPlugin = {
  async fetchDidSucceed({ request, response }) {
    if (!isPrecacheResponseAllowed(request, response)) {
      throw new Error(`拒绝预缓存不安全响应: ${request.url}`);
    }
    return response;
  },
  async cacheWillUpdate({ request, response }) {
    return isPrecacheResponseAllowed(request, response) ? response : null;
  }
};
import type { WorkboxPlugin } from "workbox-core/types.js";

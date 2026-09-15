/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { addPlugins, cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";
import { precacheResponseValidationPlugin } from "./pwa/precacheResponsePolicy";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};
declare const __LLM_BOT_RELEASE_ID__: string;

const webuiIndexUrl = "/webui/index.html";

clientsClaim();

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }
  if (event.data?.type === "GET_RELEASE_ID") {
    event.source?.postMessage({
      type: "WEBUI_RELEASE_ID",
      releaseId: __LLM_BOT_RELEASE_ID__
    });
  }
});

// fetchDidSucceed sees the original network response before Workbox copies a
// redirected response for cache insertion; cacheWillUpdate rechecks MIME at
// the cache boundary. Either rejection aborts installation of the new worker.
addPlugins([precacheResponseValidationPlugin]);
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

async function handleNavigation(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.status < 500) {
      return response;
    }
  } catch {
    // Fall back to the cached app shell only when the network path is unavailable.
  }

  const cached = await matchPrecache(webuiIndexUrl);
  return cached ?? Response.error();
}

registerRoute(
  new NavigationRoute(({ request }) => handleNavigation(request), {
    denylist: [/^\/api\//]
  })
);

registerRoute(
  ({ url }) => url.pathname.startsWith("/api/"),
  new NetworkOnly(),
  "GET"
);

export {};

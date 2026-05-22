/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const webuiIndexUrl = "/webui/index.html";

self.skipWaiting();
clientsClaim();

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

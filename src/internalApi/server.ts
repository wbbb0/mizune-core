import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { registerBasicRoutes } from "./routes/basicRoutes.ts";
import { registerBrowserRoutes } from "./routes/browserRoutes.ts";
import { registerMessagingRoutes } from "./routes/messagingRoutes.ts";
import { registerShellRoutes } from "./routes/shellRoutes.ts";
import { registerUploadRoutes } from "./routes/uploadRoutes.ts";
import { registerAuthRoutes } from "./routes/authRoutes.ts";
import { loadOrCreateWebuiAuth } from "./auth/webuiAuthStore.ts";
import { buildCookieName, verifySessionToken } from "./auth/webuiAuth.ts";
import type { InternalApiRuntimeDeps, InternalApiServices } from "./types.ts";
import { registerWebuiStaticRoutes } from "./webuiStatic.ts";

// Routes that do not require authentication.
const AUTH_EXEMPT_PATHS = new Set([
  "/api/auth/me",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/passkey/login/options",
  "/api/auth/passkey/login/verify",
  "/healthz"
]);
const AUTH_EXEMPT_PREFIXES = ["/webui/"];

function isAuthExempt(url: string): boolean {
  return AUTH_EXEMPT_PATHS.has(url) || AUTH_EXEMPT_PREFIXES.some((prefix) => url === prefix.slice(0, -1) || url.startsWith(prefix));
}

function resolveWebuiDistPath(): string {
  // Works both with tsx (src/) and after tsdown compilation (dist/).
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(dir, "../webui/dist"),
    join(dir, "../../webui/dist")
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  return resolved ?? candidates[0]!;
}

function registerInternalApiRoutes(app: FastifyInstance, services: InternalApiServices): void {
  registerBasicRoutes(app, services.basicRoutes);
  registerBrowserRoutes(app, services.browserRoutes);
  registerShellRoutes(app, services.shellRoutes);
  registerMessagingRoutes(app, services.messagingRoutes);
  registerUploadRoutes(app, services.uploadRoutes);
}

export async function startInternalApi(deps: InternalApiRuntimeDeps) {
  const app = Fastify({ logger: false });
  const { services } = deps;
  const webuiEnabled = deps.config.internalApi.webui.enabled;
  const webuiAuthEnabled = webuiEnabled && deps.config.internalApi.webui.auth.enabled;
  const externalWebuiMode = process.env.LLM_BOT_WEBUI_MODE === "external" && webuiEnabled;

  // Compute listen port early so the cookie name can be derived from it.
  const listenPort = externalWebuiMode
    ? deps.config.internalApi.port
    : webuiEnabled
      ? deps.config.internalApi.webui.port
      : deps.config.internalApi.port;
  const cookieName = buildCookieName(listenPort);

  // --- Cookie support (required for auth) ---
  await app.register(fastifyCookie);

  // --- WebUI static files ---
  let authData: Awaited<ReturnType<typeof loadOrCreateWebuiAuth>> | null = null;

  if (webuiEnabled) {
    authData = await loadOrCreateWebuiAuth(deps.config.dataDir, deps.logger);

    registerAuthRoutes(app, {
      authData,
      authEnabled: webuiAuthEnabled,
      dataDir: deps.config.dataDir,
      cookieName,
      defaultRpName: `${deps.config.appName} WebUI`,
      allowedHosts: deps.config.internalApi.webui.allowedHosts
    });

    if (!externalWebuiMode) {
      const distPath = resolveWebuiDistPath();
      if (existsSync(distPath)) {
        await registerWebuiStaticRoutes(app, distPath);
        deps.logger.info({ distPath }, "webui_static_serving_enabled");
      } else {
        deps.logger.warn({ distPath }, "webui_dist_not_found — run `npm run build:webui` first");
      }
    }
  }

  // --- Auth preHandler (protects all /api/* except /api/auth/*) ---
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || isAuthExempt(request.url)) {
      return;
    }
    if (!webuiAuthEnabled) {
      // WebUI auth disabled → internal API is unauthenticated.
      return;
    }
    const cookie = request.cookies[cookieName];
    if (
      !authData ||
      !cookie ||
      !verifySessionToken(authData.passwordHash, authData.sessionVersion, cookie)
    ) {
      await reply.status(401).send({ error: "Unauthorized" });
    }
  });

  registerInternalApiRoutes(app, services);

  // When webui is enabled, bind to 0.0.0.0 on the webui port so external
  // devices (e.g. phones on the LAN) can reach the PWA.  Auth middleware
  // protects all API routes, so public exposure is safe.
  // When webui is disabled, stay on 127.0.0.1 (local-only, unauthenticated).
  const listenHost = externalWebuiMode
    ? "127.0.0.1"
    : webuiEnabled
      ? "0.0.0.0"
      : "127.0.0.1";

  await app.listen({ port: listenPort, host: listenHost });
  deps.logger.info({ port: listenPort, host: listenHost }, "internal_api_started");

  return {
    close: async () => {
      await app.close();
      deps.logger.info("internal_api_stopped");
    }
  };
}

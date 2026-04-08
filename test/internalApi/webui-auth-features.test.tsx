import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import pino from "pino";
import { COOKIE_NAME, verifyPassword, verifySessionToken } from "../../src/internalApi/auth/webuiAuth.ts";
import { getWebuiAuthFilePath, loadOrCreateWebuiAuth } from "../../src/internalApi/auth/webuiAuthStore.ts";
import { registerAuthRoutes } from "../../src/internalApi/routes/authRoutes.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function createAuthTestApp(input?: { initialToken?: string }) {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-webui-auth-"));
  if (input?.initialToken) {
    await writeFile(getWebuiAuthFilePath(dataDir), JSON.stringify({ accessToken: input.initialToken }, null, 2), "utf8");
  }

  const authData = await loadOrCreateWebuiAuth(dataDir, pino({ level: "silent" }));
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  registerAuthRoutes(app, {
    authData,
    dataDir,
    defaultRpName: "llm-bot WebUI",
    allowedHosts: ["localhost"]
  });

  app.addHook("preHandler", async (request, reply) => {
    if (
      request.url === "/api/auth/me" ||
      request.url === "/api/auth/login" ||
      request.url === "/api/auth/logout" ||
      request.url === "/api/auth/passkey/login/options" ||
      request.url === "/api/auth/passkey/login/verify"
    ) {
      return;
    }
    if (!request.url.startsWith("/api/auth/")) {
      return;
    }
    const cookie = request.cookies[COOKIE_NAME];
    if (!cookie || !verifySessionToken(authData.passwordHash, authData.sessionVersion, cookie)) {
      await reply.status(401).send({ error: "Unauthorized" });
    }
  });

  await app.ready();
  return { app, authData, dataDir };
}

async function main() {
  await runCase("legacy accessToken auth file is migrated to password auth", async () => {
    const { app, authData, dataDir } = await createAuthTestApp({ initialToken: "legacy-secret" });
    try {
      assert.equal(verifyPassword("legacy-secret", authData.passwordHash), true);
      assert.equal(authData.sessionVersion, 1);
      const saved = JSON.parse(await readFile(getWebuiAuthFilePath(dataDir), "utf8")) as Record<string, unknown>;
      assert.equal(typeof saved.passwordHash, "string");
      assert.equal(saved.accessToken, undefined);
    } finally {
      await app.close();
    }
  });

  await runCase("password change invalidates old sessions and old password", async () => {
    const { app } = await createAuthTestApp({ initialToken: "old-secret" });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "old-secret" }
      });
      assert.equal(login.statusCode, 200);
      const cookie = login.cookies[0]?.value;
      assert.ok(cookie);

      const settingsBefore = await app.inject({
        method: "GET",
        url: "/api/auth/settings",
        cookies: { [COOKIE_NAME]: cookie }
      });
      assert.equal(settingsBefore.statusCode, 200);
      assert.equal(settingsBefore.json().username, "admin");

      const change = await app.inject({
        method: "POST",
        url: "/api/auth/password",
        cookies: { [COOKIE_NAME]: cookie },
        payload: {
          currentPassword: "old-secret",
          newPassword: "new-secret"
        }
      });
      assert.equal(change.statusCode, 200);

      const meWithOldCookie = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { [COOKIE_NAME]: cookie }
      });
      assert.equal(meWithOldCookie.statusCode, 200);
      assert.equal(meWithOldCookie.json().authenticated, false);

      const oldLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "old-secret" }
      });
      assert.equal(oldLogin.statusCode, 401);

      const newLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "new-secret" }
      });
      assert.equal(newLogin.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  await runCase("passkey registration options require an authenticated session", async () => {
    const { app } = await createAuthTestApp({ initialToken: "auth-secret" });
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/api/auth/passkey/register/options",
        headers: { origin: "http://localhost:3131", host: "localhost:3131" }
      });
      assert.equal(unauthorized.statusCode, 401);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "auth-secret" }
      });
      const cookie = login.cookies[0]?.value;
      assert.ok(cookie);

      const authorized = await app.inject({
        method: "POST",
        url: "/api/auth/passkey/register/options",
        cookies: { [COOKIE_NAME]: cookie },
        headers: { origin: "http://localhost:3131", host: "localhost:3131" }
      });
      assert.equal(authorized.statusCode, 200);
      assert.equal(typeof authorized.json().challenge, "string");
    } finally {
      await app.close();
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

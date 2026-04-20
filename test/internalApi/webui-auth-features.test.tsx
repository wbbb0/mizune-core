import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import pino from "pino";
import { buildCookieName, hashPassword, verifyPassword, verifySessionToken } from "../../src/internalApi/auth/webuiAuth.ts";
import { getWebuiAuthFilePath, loadOrCreateWebuiAuth } from "../../src/internalApi/auth/webuiAuthStore.ts";
import { registerAuthRoutes } from "../../src/internalApi/routes/authRoutes.ts";

const TEST_PASSWORD_HASH_PARAMS = { N: 1024 } as const;

async function createAuthTestApp(input?: {
  initialToken?: string;
  passwordHash?: string;
  authEnabled?: boolean;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-webui-auth-"));
  if (input?.initialToken) {
    await writeFile(getWebuiAuthFilePath(dataDir), JSON.stringify({ accessToken: input.initialToken }, null, 2), "utf8");
  } else if (input?.passwordHash) {
    await writeFile(getWebuiAuthFilePath(dataDir), JSON.stringify({
      passwordHash: input.passwordHash,
      passwordUpdatedAt: 1,
      sessionVersion: 1,
      passkey: null,
      rpName: "llm-bot WebUI"
    }, null, 2), "utf8");
  }

  const authData = await loadOrCreateWebuiAuth(dataDir, pino({ level: "silent" }));
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const cookieName = buildCookieName(3000);
  registerAuthRoutes(app, {
    authData,
    authEnabled: input?.authEnabled ?? true,
    dataDir,
    cookieName,
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
    if ((input?.authEnabled ?? true) === false) {
      return;
    }
    const cookie = request.cookies[cookieName];
    if (!cookie || !verifySessionToken(authData.passwordHash, authData.sessionVersion, cookie)) {
      await reply.status(401).send({ error: "Unauthorized" });
    }
  });

  await app.ready();
  return { app, authData, dataDir, cookieName };
}

  test("legacy accessToken auth file is migrated to password auth", async () => {
    const { app, authData, dataDir, cookieName } = await createAuthTestApp({ initialToken: "legacy-secret" });
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

  test("password change invalidates old sessions and old password", async () => {
    const { app, cookieName } = await createAuthTestApp({
      passwordHash: hashPassword("old-secret", TEST_PASSWORD_HASH_PARAMS)
    });
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
        cookies: { [cookieName]: cookie }
      });
      assert.equal(settingsBefore.statusCode, 200);
      assert.equal(settingsBefore.json().username, "admin");

      const change = await app.inject({
        method: "POST",
        url: "/api/auth/password",
        cookies: { [cookieName]: cookie },
        payload: {
          currentPassword: "old-secret",
          newPassword: "new-secret"
        }
      });
      assert.equal(change.statusCode, 200);

      const meWithOldCookie = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { [cookieName]: cookie }
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

  test("passkey registration options require an authenticated session", async () => {
    const { app, cookieName } = await createAuthTestApp({
      passwordHash: hashPassword("auth-secret", TEST_PASSWORD_HASH_PARAMS)
    });
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
        cookies: { [cookieName]: cookie },
        headers: { origin: "http://localhost:3131", host: "localhost:3131" }
      });
      assert.equal(authorized.statusCode, 200);
      assert.equal(typeof authorized.json().challenge, "string");
    } finally {
      await app.close();
    }
  });

  test("auth disabled reports disabled state and rejects auth mutations", async () => {
    const { app } = await createAuthTestApp({
      passwordHash: hashPassword("auth-secret", TEST_PASSWORD_HASH_PARAMS),
      authEnabled: false
    });
    try {
      const me = await app.inject({
        method: "GET",
        url: "/api/auth/me"
      });
      assert.equal(me.statusCode, 200);
      assert.deepEqual(me.json(), {
        enabled: false,
        authenticated: false
      });

      const settings = await app.inject({
        method: "GET",
        url: "/api/auth/settings"
      });
      assert.equal(settings.statusCode, 200);
      assert.equal(settings.json().enabled, false);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "auth-secret" }
      });
      assert.equal(login.statusCode, 409);
      assert.equal(login.json().error, "WebUI auth is disabled");

      const changePassword = await app.inject({
        method: "POST",
        url: "/api/auth/password",
        payload: {
          currentPassword: "auth-secret",
          newPassword: "new-secret"
        }
      });
      assert.equal(changePassword.statusCode, 409);
      assert.equal(changePassword.json().error, "WebUI auth is disabled");
    } finally {
      await app.close();
    }
  });

  test("password change preserves explicit scrypt params from the existing hash", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-webui-auth-"));
    const lowCostHash = hashPassword("old-secret", TEST_PASSWORD_HASH_PARAMS);
    await writeFile(getWebuiAuthFilePath(dataDir), JSON.stringify({
      passwordHash: lowCostHash,
      passwordUpdatedAt: 1,
      sessionVersion: 1,
      passkey: null,
      rpName: "llm-bot WebUI"
    }, null, 2), "utf8");

    const authData = await loadOrCreateWebuiAuth(dataDir, pino({ level: "silent" }));
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    const cookieName = buildCookieName(3000);
    registerAuthRoutes(app, {
      authData,
      authEnabled: true,
      dataDir,
      cookieName,
      defaultRpName: "llm-bot WebUI",
      allowedHosts: ["localhost"]
    });
    await app.ready();

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "old-secret" }
      });
      const cookie = login.cookies[0]?.value;
      assert.ok(cookie);

      const change = await app.inject({
        method: "POST",
        url: "/api/auth/password",
        cookies: { [cookieName]: cookie },
        payload: {
          currentPassword: "old-secret",
          newPassword: "new-secret"
        }
      });
      assert.equal(change.statusCode, 200);

      const saved = JSON.parse(await readFile(getWebuiAuthFilePath(dataDir), "utf8")) as { passwordHash: string };
      assert.match(saved.passwordHash, /N=1024/);

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

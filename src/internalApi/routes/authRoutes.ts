import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import {
  COOKIE_MAX_AGE_SECONDS,
  createSessionToken,
  getPasswordHashParams,
  hashPassword,
  verifyPassword,
  verifySessionToken
} from "../auth/webuiAuth.ts";
import type { StoredPasskey, WebuiAuthData } from "../auth/webuiAuthStore.ts";
import { saveWebuiAuth } from "../auth/webuiAuthStore.ts";

type PendingCeremony = {
  challenge: string;
  origin: string;
  rpId: string;
  expiresAt: number;
};

const DEFAULT_RP_NAME = "llm-bot WebUI";
const CEREMONY_TTL_MS = 5 * 60 * 1000;
const FIXED_USERNAME = "admin";

export function registerAuthRoutes(app: FastifyInstance, options: {
  authData: WebuiAuthData;
  authEnabled: boolean;
  dataDir: string;
  cookieName: string;
  defaultRpName?: string;
  allowedHosts?: string[];
}): void {
  const { cookieName } = options;
  const state = {
    pendingRegistration: null as PendingCeremony | null,
    pendingAuthentication: null as PendingCeremony | null
  };

  app.get("/api/auth/me", async (request) => {
    if (!options.authEnabled) {
      return { enabled: false, authenticated: false };
    }

    const cookie = request.cookies[cookieName];
    const authenticated = typeof cookie === "string" && verifySessionToken(
      options.authData.passwordHash,
      options.authData.sessionVersion,
      cookie
    );
    return { enabled: true, authenticated };
  });

  app.get("/api/auth/settings", async () => ({
    enabled: options.authEnabled,
    username: FIXED_USERNAME,
    passwordUpdatedAt: options.authData.passwordUpdatedAt,
    passkey: options.authData.passkey
      ? {
          label: options.authData.passkey.label,
          createdAt: options.authData.passkey.createdAt,
          lastUsedAt: options.authData.passkey.lastUsedAt ?? null
        }
      : null
  }));

  app.post("/api/auth/login", async (request, reply) => {
    if (!options.authEnabled) {
      return reply.status(409).send({ error: "WebUI auth is disabled" });
    }

    const body = request.body as Record<string, unknown> | null;
    const password = typeof body?.password === "string" ? body.password : "";
    if (!password || !verifyPassword(password, options.authData.passwordHash)) {
      return reply.status(401).send({ error: "Invalid password" });
    }

    return issueSession(reply, options.authData, cookieName);
  });

  app.post("/api/auth/password", async (request, reply) => {
    if (!options.authEnabled) {
      return reply.status(409).send({ error: "WebUI auth is disabled" });
    }

    const body = request.body as Record<string, unknown> | null;
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword.trim() : "";

    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: "currentPassword and newPassword are required" });
    }
    if (!verifyPassword(currentPassword, options.authData.passwordHash)) {
      return reply.status(401).send({ error: "Current password is incorrect" });
    }

    options.authData.passwordHash = hashPassword(newPassword, getPasswordHashParams(options.authData.passwordHash) ?? undefined);
    options.authData.passwordUpdatedAt = Date.now();
    options.authData.sessionVersion += 1;
    await saveWebuiAuth(options.dataDir, options.authData);
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/passkey/register/options", async (request, reply) => {
    if (!options.authEnabled) {
      return reply.status(409).send({ error: "WebUI auth is disabled" });
    }

    const ceremony = createPendingCeremony(request, options.allowedHosts ?? [], options.authData.rpId);
    if (!ceremony) {
      return reply.status(400).send({ error: "Passkey registration requires a valid WebUI origin" });
    }

    const registrationOptions = await generateRegistrationOptions({
      rpName: options.authData.rpName ?? options.defaultRpName ?? DEFAULT_RP_NAME,
      rpID: ceremony.rpId,
      userName: FIXED_USERNAME,
      userDisplayName: "WebUI Admin",
      userID: new TextEncoder().encode(FIXED_USERNAME),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred"
      },
      excludeCredentials: options.authData.passkey
        ? [{
            id: options.authData.passkey.credential.id,
            ...(options.authData.passkey.credential.transports
              ? { transports: options.authData.passkey.credential.transports as AuthenticatorTransportFuture[] }
              : {})
          }]
        : []
    });

    state.pendingRegistration = {
      challenge: registrationOptions.challenge,
      origin: ceremony.origin,
      rpId: ceremony.rpId,
      expiresAt: Date.now() + CEREMONY_TTL_MS
    };
    return registrationOptions;
  });

  app.post("/api/auth/passkey/register/verify", async (request, reply) => {
    if (!options.authEnabled) {
      return reply.status(409).send({ error: "WebUI auth is disabled" });
    }

    const pending = getPendingCeremony(state.pendingRegistration);
    if (!pending) {
      return reply.status(400).send({ error: "No active passkey registration" });
    }

    const body = request.body as Record<string, unknown> | null;
    const response = body?.response as RegistrationResponseJSON | undefined;
    const label = typeof body?.label === "string" && body.label.trim() !== "" ? body.label.trim() : "当前设备";
    if (!response) {
      return reply.status(400).send({ error: "Passkey registration response is required" });
    }

    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId
      });
      if (!verification.verified || !verification.registrationInfo) {
        return reply.status(400).send({ error: "Passkey registration could not be verified" });
      }

      options.authData.passkey = {
        label,
        createdAt: Date.now(),
        credential: {
          id: verification.registrationInfo.credential.id,
          publicKey: Buffer.from(verification.registrationInfo.credential.publicKey).toString("base64url"),
          counter: verification.registrationInfo.credential.counter,
          ...(response.response.transports ? { transports: response.response.transports } : {})
        }
      };
      options.authData.rpId = pending.rpId;
      options.authData.rpName = options.authData.rpName ?? options.defaultRpName ?? DEFAULT_RP_NAME;
      await saveWebuiAuth(options.dataDir, options.authData);
      state.pendingRegistration = null;
      return { ok: true };
    } catch (error: unknown) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "Passkey registration failed" });
    }
  });

  app.post("/api/auth/passkey/login/options", async (request, reply) => {
    if (!options.authEnabled) {
      return reply.status(409).send({ error: "WebUI auth is disabled" });
    }

    if (!options.authData.passkey) {
      return reply.status(400).send({ error: "No passkey registered" });
    }
    const ceremony = createPendingCeremony(request, options.allowedHosts ?? [], options.authData.rpId);
    if (!ceremony) {
      return reply.status(400).send({ error: "Passkey login requires a valid WebUI origin" });
    }

    const authnOptions = await generateAuthenticationOptions({
      rpID: ceremony.rpId,
      allowCredentials: [{
        id: options.authData.passkey.credential.id,
        ...(options.authData.passkey.credential.transports
          ? { transports: options.authData.passkey.credential.transports as AuthenticatorTransportFuture[] }
          : {})
      }],
      userVerification: "preferred"
    });

    state.pendingAuthentication = {
      challenge: authnOptions.challenge,
      origin: ceremony.origin,
      rpId: ceremony.rpId,
      expiresAt: Date.now() + CEREMONY_TTL_MS
    };
    return authnOptions;
  });

  app.post("/api/auth/passkey/login/verify", async (request, reply) => {
    if (!options.authEnabled) {
      return reply.status(409).send({ error: "WebUI auth is disabled" });
    }

    const pending = getPendingCeremony(state.pendingAuthentication);
    if (!pending || !options.authData.passkey) {
      return reply.status(400).send({ error: "No active passkey login" });
    }
    const body = request.body as Record<string, unknown> | null;
    const response = body?.response as AuthenticationResponseJSON | undefined;
    if (!response) {
      return reply.status(400).send({ error: "Passkey login response is required" });
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        credential: {
          id: options.authData.passkey.credential.id,
          publicKey: Buffer.from(options.authData.passkey.credential.publicKey, "base64url"),
          counter: options.authData.passkey.credential.counter,
          ...(options.authData.passkey.credential.transports
            ? { transports: options.authData.passkey.credential.transports as AuthenticatorTransportFuture[] }
            : {})
        }
      });
      if (!verification.verified) {
        return reply.status(401).send({ error: "Passkey login failed" });
      }

      options.authData.passkey.credential.counter = verification.authenticationInfo.newCounter;
      options.authData.passkey.lastUsedAt = Date.now();
      await saveWebuiAuth(options.dataDir, options.authData);
      state.pendingAuthentication = null;
      return issueSession(reply, options.authData, cookieName);
    } catch (error: unknown) {
      return reply.status(401).send({ error: error instanceof Error ? error.message : "Passkey login failed" });
    }
  });

  app.delete("/api/auth/passkey", async (_, reply) => {
    if (!options.authEnabled) {
      return reply.status(409).send({ error: "WebUI auth is disabled" });
    }

    options.authData.passkey = null;
    await saveWebuiAuth(options.dataDir, options.authData);
    state.pendingRegistration = null;
    state.pendingAuthentication = null;
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_, reply) => {
    if (!options.authEnabled) {
      return { ok: true };
    }

    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });
}

function issueSession(reply: FastifyReply, authData: WebuiAuthData, cookieName: string) {
  const session = createSessionToken(authData.passwordHash, authData.sessionVersion);
  reply.setCookie(cookieName, session, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS
  });
  return { ok: true };
}

function getPendingCeremony(pending: PendingCeremony | null): PendingCeremony | null {
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) {
    return null;
  }
  return pending;
}

function createPendingCeremony(
  request: FastifyRequest,
  allowedHosts: string[],
  storedRpId?: string
): { origin: string; rpId: string } | null {
  const originHeader = typeof request.headers.origin === "string" ? request.headers.origin : "";
  const hostHeader = typeof request.headers.host === "string" ? request.headers.host : "";

  const allowedRpId = normalizeRpId(allowedHosts[0]);
  const fallbackHost = normalizeRpId(hostHeader);
  const origin = resolveOrigin(originHeader, hostHeader, allowedRpId ?? fallbackHost);
  const originHost = origin ? new URL(origin).hostname : undefined;
  const rpId = storedRpId ?? allowedRpId ?? originHost;
  if (!origin || !rpId) {
    return null;
  }
  return { origin, rpId };
}

function resolveOrigin(originHeader: string, hostHeader: string, fallbackHost?: string): string | null {
  if (originHeader) {
    try {
      return new URL(originHeader).origin;
    } catch {
      return null;
    }
  }
  const host = fallbackHost ?? normalizeRpId(hostHeader);
  if (!host) return null;
  const protocol = host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? "http" : "https";
  return `${protocol}://${host}`;
}

function normalizeRpId(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const trimmed = host.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^https?:\/\//, "").split("/")[0]!.split(":")[0]!;
}

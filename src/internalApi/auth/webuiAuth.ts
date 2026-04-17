import { createHmac, randomBytes, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_HASH_PREFIX = "scrypt";
const DEFAULT_PASSWORD_HASH_PARAMS = {
  N: 16384,
  r: 8,
  p: 1
} satisfies Pick<ScryptOptions, "N" | "r" | "p">;

export { COOKIE_MAX_AGE_SECONDS };

export type PasswordHashParams = Pick<ScryptOptions, "N" | "r" | "p" | "maxmem">;

export function buildCookieName(port: number): string {
  return `webui-session-${port}`;
}

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function hashPassword(password: string, params?: PasswordHashParams): string {
  const normalizedParams = normalizePasswordHashParams(params);
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 32, normalizedParams).toString("hex");
  const encodedParams = encodePasswordHashParams(normalizedParams);
  return encodedParams
    ? `${PASSWORD_HASH_PREFIX}$${encodedParams}$${salt}$${derived}`
    : `${PASSWORD_HASH_PREFIX}$${salt}$${derived}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const parsed = parsePasswordHash(passwordHash);
  if (!parsed) {
    return false;
  }
  try {
    const actual = scryptSync(password, parsed.salt, 32, parsed.params);
    const expected = Buffer.from(parsed.expectedHash, "hex");
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function getPasswordHashParams(passwordHash: string): PasswordHashParams | null {
  const parsed = parsePasswordHash(passwordHash);
  return parsed ? { ...parsed.params } : null;
}

function parsePasswordHash(passwordHash: string): {
  salt: string;
  expectedHash: string;
  params: PasswordHashParams;
} | null {
  const parts = passwordHash.split("$");
  if (parts[0] !== PASSWORD_HASH_PREFIX) {
    return null;
  }

  if (parts.length === 3) {
    const [, salt, expectedHash] = parts;
    if (!salt || !expectedHash) {
      return null;
    }
    return {
      salt,
      expectedHash,
      params: normalizePasswordHashParams()
    };
  }

  if (parts.length === 4) {
    const [, encodedParams, salt, expectedHash] = parts;
    if (!encodedParams || !salt || !expectedHash) {
      return null;
    }
    const params = decodePasswordHashParams(encodedParams);
    if (!params) {
      return null;
    }
    return {
      salt,
      expectedHash,
      params
    };
  }

  return null;
}

function normalizePasswordHashParams(params?: PasswordHashParams): PasswordHashParams {
  return {
    ...DEFAULT_PASSWORD_HASH_PARAMS,
    ...(params?.maxmem != null ? { maxmem: params.maxmem } : {}),
    ...(params?.N != null ? { N: params.N } : {}),
    ...(params?.r != null ? { r: params.r } : {}),
    ...(params?.p != null ? { p: params.p } : {})
  };
}

function encodePasswordHashParams(params: PasswordHashParams): string | null {
  const normalizedDefaults = normalizePasswordHashParams();
  if (
    params.N === normalizedDefaults.N
    && params.r === normalizedDefaults.r
    && params.p === normalizedDefaults.p
    && params.maxmem === normalizedDefaults.maxmem
  ) {
    return null;
  }

  const fields = [
    `N=${params.N}`,
    `r=${params.r}`,
    `p=${params.p}`
  ];
  if (params.maxmem != null) {
    fields.push(`maxmem=${params.maxmem}`);
  }
  return fields.join(",");
}

function decodePasswordHashParams(input: string): PasswordHashParams | null {
  const entries = input.split(",");
  const parsed: Record<string, number> = {};
  for (const entry of entries) {
    const [rawKey, rawValue] = entry.split("=");
    if (!rawKey || !rawValue) {
      return null;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    parsed[rawKey] = Math.floor(value);
  }

  if (!parsed.N || !parsed.r || !parsed.p) {
    return null;
  }

  return normalizePasswordHashParams({
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    ...(parsed.maxmem ? { maxmem: parsed.maxmem } : {})
  });
}

export function createSessionToken(secret: string, sessionVersion: number): string {
  const id = randomBytes(24).toString("hex");
  const version = String(sessionVersion);
  const sig = sign(secret, `${version}.${id}`);
  return `${version}.${id}.${sig}`;
}

export function verifySessionToken(secret: string, sessionVersion: number, token: string): boolean {
  if (typeof token !== "string") {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [version, id, sig] = parts;
  if (version !== String(sessionVersion) || !id || !sig) {
    return false;
  }

  const expected = sign(secret, `${version}.${id}`);
  try {
    const sigBuf = Buffer.from(sig, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "webui-session";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_HASH_PREFIX = "scrypt";

export { COOKIE_NAME, COOKIE_MAX_AGE_SECONDS };

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 32).toString("hex");
  return `${PASSWORD_HASH_PREFIX}$${salt}$${derived}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [prefix, salt, expectedHash] = passwordHash.split("$");
  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !expectedHash) {
    return false;
  }
  try {
    const actual = scryptSync(password, salt, 32);
    const expected = Buffer.from(expectedHash, "hex");
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
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

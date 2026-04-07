import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { hashPassword } from "./webuiAuth.ts";

export interface StoredPasskey {
  label: string;
  credential: {
    id: string;
    publicKey: string;
    counter: number;
    transports?: string[];
  };
  createdAt: number;
  lastUsedAt?: number;
}

export interface WebuiAuthData {
  passwordHash: string;
  passwordUpdatedAt: number;
  sessionVersion: number;
  passkey: StoredPasskey | null;
  rpId?: string;
  rpName?: string;
}

const AUTH_FILE = "webui-auth.json";

export function getWebuiAuthFilePath(dataDir: string): string {
  return join(dataDir, AUTH_FILE);
}

export async function saveWebuiAuth(dataDir: string, data: WebuiAuthData): Promise<void> {
  await writeFile(getWebuiAuthFilePath(dataDir), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function loadOrCreateWebuiAuth(dataDir: string, logger: Logger): Promise<WebuiAuthData> {
  const filePath = getWebuiAuthFilePath(dataDir);

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeWebuiAuthData(parsed);
    if (normalized) {
      if (!isCurrentWebuiAuthDataShape(parsed)) {
        await saveWebuiAuth(dataDir, normalized);
      }
      return normalized;
    }
  } catch {
    // File missing or invalid — generate a new password below.
  }

  const password = randomBytes(24).toString("hex");
  const now = Date.now();
  const data: WebuiAuthData = {
    passwordHash: hashPassword(password),
    passwordUpdatedAt: now,
    sessionVersion: 1,
    passkey: null,
    rpName: "llm-bot WebUI"
  };
  await saveWebuiAuth(dataDir, data);

  logger.info(
    { filePath },
    [
      "webui_password_generated",
      `WebUI password: ${password}`,
      "Visit /webui/ and enter this password to log in."
    ].join(" | ")
  );

  return data;
}

function normalizeWebuiAuthData(input: unknown): WebuiAuthData | null {
  if (input == null || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.passwordHash === "string" && record.passwordHash !== "") {
    return {
      passwordHash: record.passwordHash,
      passwordUpdatedAt: typeof record.passwordUpdatedAt === "number" ? record.passwordUpdatedAt : Date.now(),
      sessionVersion: typeof record.sessionVersion === "number" && record.sessionVersion >= 1 ? Math.floor(record.sessionVersion) : 1,
      passkey: normalizeStoredPasskey(record.passkey),
      ...(typeof record.rpId === "string" && record.rpId !== "" ? { rpId: record.rpId } : {}),
      ...(typeof record.rpName === "string" && record.rpName !== "" ? { rpName: record.rpName } : {})
    };
  }

  if (typeof record.accessToken === "string" && record.accessToken !== "") {
    const now = Date.now();
    return {
      passwordHash: hashPassword(record.accessToken),
      passwordUpdatedAt: now,
      sessionVersion: 1,
      passkey: null,
      rpName: "llm-bot WebUI"
    };
  }

  return null;
}

function normalizeStoredPasskey(input: unknown): StoredPasskey | null {
  if (input == null) {
    return null;
  }
  if (typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const credential = record.credential;
  if (
    typeof record.label !== "string" ||
    typeof record.createdAt !== "number" ||
    credential == null ||
    typeof credential !== "object"
  ) {
    return null;
  }

  const parsedCredential = credential as Record<string, unknown>;
  if (
    typeof parsedCredential.id !== "string" ||
    typeof parsedCredential.publicKey !== "string" ||
    typeof parsedCredential.counter !== "number"
  ) {
    return null;
  }

  return {
    label: record.label,
    createdAt: record.createdAt,
    ...(typeof record.lastUsedAt === "number" ? { lastUsedAt: record.lastUsedAt } : {}),
    credential: {
      id: parsedCredential.id,
      publicKey: parsedCredential.publicKey,
      counter: Math.floor(parsedCredential.counter),
      ...(Array.isArray(parsedCredential.transports)
        ? { transports: parsedCredential.transports.filter((item): item is string => typeof item === "string") }
        : {})
    }
  };
}

function isCurrentWebuiAuthDataShape(input: unknown): boolean {
  if (input == null || typeof input !== "object") {
    return false;
  }
  const record = input as Record<string, unknown>;
  return typeof record.passwordHash === "string";
}

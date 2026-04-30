import { createHash } from "node:crypto";

export function contentSafetyHashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function contentSafetyHashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}


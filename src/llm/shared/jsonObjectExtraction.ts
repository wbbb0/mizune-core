import { jsonrepair } from "jsonrepair";

export type JsonObjectParseStatus = "parsed" | "repaired";

export interface JsonObjectParseResult {
  value: Record<string, unknown>;
  parseStatus: JsonObjectParseStatus;
}

export function parseJsonObjectFromText(raw: string): JsonObjectParseResult | null {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    extractFencedJson(trimmed),
    extractObjectJson(trimmed)
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const parsed = parsePlainObject(candidate);
    if (parsed) {
      return {
        value: parsed,
        parseStatus: "parsed"
      };
    }
  }

  for (const candidate of candidates) {
    const parsed = repairObjectJson(candidate);
    if (parsed) {
      return {
        value: parsed,
        parseStatus: "repaired"
      };
    }
  }

  return null;
}

function repairObjectJson(candidate: string): Record<string, unknown> | null {
  try {
    return parsePlainObject(jsonrepair(candidate));
  } catch {
    return null;
  }
}

function parsePlainObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractFencedJson(raw: string): string | null {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function extractObjectJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1).trim();
}

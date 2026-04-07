import { jsonrepair } from "jsonrepair";
import type { Logger } from "pino";

export function parseToolArguments(
  raw: string,
  logger: Logger,
  context: {
    toolName: string;
    toolCallId?: string;
  }
): unknown {
  try {
    return parseNormalizedToolArguments(raw);
  } catch (error: unknown) {
    try {
      const repaired = normalizeToolArgumentJson(jsonrepair(raw));
      logger.warn(
        {
          toolName: context.toolName,
          toolCallId: context.toolCallId,
          rawPreview: raw.slice(0, 300),
          repairedPreview: repaired.slice(0, 300)
        },
        "tool_arguments_repaired"
      );
      return JSON.parse(repaired);
    } catch {
      logger.warn(
        {
          toolName: context.toolName,
          toolCallId: context.toolCallId,
          rawPreview: raw.slice(0, 300),
          error: serializeError(error)
        },
        "tool_arguments_parse_failed"
      );
      return raw;
    }
  }
}

function parseNormalizedToolArguments(raw: string): unknown {
  return JSON.parse(normalizeToolArgumentJson(raw));
}

export function extractToolError(toolResult: string): string | null {
  try {
    const parsed = JSON.parse(toolResult) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim()
      ? parsed.error.trim()
      : null;
  } catch {
    return null;
  }
}

function serializeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      ...(error.name ? { name: error.name } : {}),
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }

  return {
    message: String(error)
  };
}

function normalizeToolArgumentJson(raw: string): string {
  return quoteUnsafeIntegerLiterals(raw);
}

function quoteUnsafeIntegerLiterals(raw: string): string {
  let result = "";
  let cursor = 0;
  let inString = false;
  let escaping = false;

  while (cursor < raw.length) {
    const char = raw[cursor] ?? "";

    if (inString) {
      result += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      cursor += 1;
      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      cursor += 1;
      continue;
    }

    if (char === "-" || isDigit(char)) {
      const tokenStart = cursor;
      if (char === "-") {
        const nextChar = raw[cursor + 1] ?? "";
        if (!isDigit(nextChar)) {
          result += char;
          cursor += 1;
          continue;
        }
        cursor += 1;
      }

      while (cursor < raw.length && isDigit(raw[cursor] ?? "")) {
        cursor += 1;
      }

      let isPureInteger = true;
      if ((raw[cursor] ?? "") === ".") {
        isPureInteger = false;
        cursor += 1;
        while (cursor < raw.length && isDigit(raw[cursor] ?? "")) {
          cursor += 1;
        }
      }

      const exponentMarker = raw[cursor] ?? "";
      if (exponentMarker === "e" || exponentMarker === "E") {
        isPureInteger = false;
        cursor += 1;
        const exponentSign = raw[cursor] ?? "";
        if (exponentSign === "+" || exponentSign === "-") {
          cursor += 1;
        }
        while (cursor < raw.length && isDigit(raw[cursor] ?? "")) {
          cursor += 1;
        }
      }

      const token = raw.slice(tokenStart, cursor);
      if (isPureInteger && isUnsafeIntegerLiteral(token)) {
        result += `"${token}"`;
      } else {
        result += token;
      }
      continue;
    }

    result += char;
    cursor += 1;
  }

  return result;
}

function isUnsafeIntegerLiteral(token: string): boolean {
  const normalized = token.startsWith("-") ? token.slice(1) : token;
  if (!normalized || normalized.length < 16) {
    return false;
  }

  try {
    const value = BigInt(token);
    return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER);
  } catch {
    return false;
  }
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

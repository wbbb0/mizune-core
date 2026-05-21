import pino from "pino";
import pretty from "pino-pretty";
import type { AppConfig } from "./config/config.ts";
import type { RecentErrorLogInput } from "#runtime/recentErrorStore.ts";

export interface LoggerOptions {
  recentErrorSink?: (input: RecentErrorLogInput) => void;
}

function formatLogTimestamp(value: unknown, timeZone: string): string {
  const date = new Date(typeof value === "number" || typeof value === "string" ? value : Number.NaN);
  if (Number.isNaN(date.getTime())) {
    return `[${String(value)}]`;
  }

  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");

  return `[${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}]`;
}

export function createLogger(config: AppConfig, options: LoggerOptions = {}) {
  const logTimeZone = config.scheduler.defaultTimezone;
  const stream = pretty({
    colorize: true,
    singleLine: true,
    ignore: "pid,hostname,app,name",
    customPrettifiers: {
      time: (value) => formatLogTimestamp(value, logTimeZone)
    },
    messageFormat: (log: Record<string, unknown>, messageKey: string) => {
      const parts = [
        String(log.level ?? ""),
        log.app ? `app=${String(log.app)}` : "",
        log.sessionId ? `session=${String(log.sessionId)}` : "",
        log.userId ? `user=${String(log.userId)}` : "",
        log.groupId ? `group=${String(log.groupId)}` : "",
        log.jobId ? `job=${String(log.jobId)}` : "",
        log.toolName ? `tool=${String(log.toolName)}` : "",
        log.reason ? `reason=${String(log.reason)}` : "",
        String(log[messageKey] ?? "")
      ].filter(Boolean);
      return parts.join(" | ");
    }
  });

  return pino({
    name: config.appName,
    level: config.logLevel,
    hooks: {
      logMethod(args, method, level) {
        method.apply(this, args);
        if (level >= 50) {
          captureRecentErrorLog(args, level, options.recentErrorSink);
        }
      }
    },
    serializers: {
      error: pino.stdSerializers.err,
      err: pino.stdSerializers.err
    },
    base: {
      pid: process.pid,
      app: config.appName
    }
  }, stream);
}

function captureRecentErrorLog(
  args: Parameters<pino.LogFn>,
  level: number,
  sink: LoggerOptions["recentErrorSink"]
): void {
  if (!sink) {
    return;
  }
  try {
    const first = args[0];
    const second = args[1];
    const fields = isPlainObject(first) ? first : {};
    const event = typeof second === "string"
      ? second
      : typeof first === "string"
        ? first
        : "";
    const errorDetails = normalizeErrorDetails(fields.err ?? fields.error ?? (first instanceof Error ? first : null));
    const context = pickRecentErrorContext(fields);
    sink({
      level: level >= 60 ? "fatal" : "error",
      capturedAtMs: Date.now(),
      event,
      message: errorDetails.message || event,
      ...(errorDetails.name ? { errorName: errorDetails.name } : {}),
      ...(errorDetails.stack ? { stack: errorDetails.stack } : {}),
      context
    });
  } catch {
    // Logging must never fail because recent-error capture failed.
  }
}

function normalizeErrorDetails(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      ...(error.name ? { name: error.name } : {}),
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }
  if (isPlainObject(error)) {
    const name = typeof error.name === "string" ? error.name : undefined;
    const message = typeof error.message === "string"
      ? error.message
      : stringifyUnknown(error);
    const stack = typeof error.stack === "string" ? error.stack : undefined;
    return {
      ...(name ? { name } : {}),
      message,
      ...(stack ? { stack } : {})
    };
  }
  if (error == null) {
    return { message: "" };
  }
  return { message: String(error) };
}

function pickRecentErrorContext(fields: Record<string, unknown>): Record<string, unknown> {
  const allowedKeys = [
    "sessionId",
    "userId",
    "groupId",
    "jobId",
    "toolName",
    "toolCallId",
    "resourceId",
    "endpoint",
    "method",
    "url",
    "statusCode",
    "providerId",
    "requestType",
    "flag",
    "command"
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => fields[key] !== undefined)
      .map((key) => [key, fields[key]])
  );
}

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { formatLogTimestamp };

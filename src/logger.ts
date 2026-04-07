import pino from "pino";
import pretty from "pino-pretty";
import type { AppConfig } from "./config/config.ts";

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

export function createLogger(config: AppConfig) {
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

export { formatLogTimestamp };

import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
import { projectToolResult } from "../core/toolResultProjection.ts";

function buildCurrentTimePayload(timezone: string): {
  nowMs: number;
  isoUtc: string;
  timezone: string;
  localTime: string;
  weekday: string;
} {
  const now = new Date();
  const localTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    weekday: "long"
  }).format(now);

  return {
    nowMs: now.getTime(),
    isoUtc: now.toISOString(),
    timezone,
    localTime,
    weekday
  };
}

export const timeToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "get_current_time",
        description: "获取当前时间，返回默认时区时间和 UTC。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 5 })
  }
];

export const timeToolHandlers: Record<string, ToolHandler> = {
  async get_current_time(_toolCall, _args, context) {
    return projectToolResult({
      toolName: "get_current_time",
      canonical: buildCurrentTimePayload(context.config.scheduler.defaultTimezone),
      projection: {
        initial: (canonical) => ({
          isoUtc: canonical.isoUtc,
          timezone: canonical.timezone,
          localTime: canonical.localTime,
          weekday: canonical.weekday
        })
      }
    });
  }
};

export { buildCurrentTimePayload };

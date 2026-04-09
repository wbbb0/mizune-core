import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { parseScheduledJobSchedule, requireOwner } from "../core/shared.ts";

export const schedulerToolDescriptors: ToolDescriptor[] = [
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "list_scheduled_jobs",
        description: "列出已创建的定时任务。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    }
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "create_scheduled_job",
        description: "仅在 owner 明确要求未来某时提醒、延后处理或定期执行时，才为一个或多个已有会话创建计划任务。delay 表示相对时间，at 表示单次绝对时间，cron 表示重复计划；instruction 必须写成触发当时可直接执行的完整任务，不要写成只对当前轮对话才成立的模糊提示。到点后模型会把它当成一次新的内部执行：若任务本身需要查资料、看图或调用其他工具，可以先完成这些步骤，再决定是否给目标会话发消息。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            instruction: { type: "string" },
            sessionIds: {
              type: "array",
              items: { type: "string" },
              minItems: 1
            },
            schedule: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["delay", "at", "cron"]
                },
                delayMs: { type: "number" },
                runAtMs: { type: "number" },
                runAtIso: { type: "string" },
                expr: { type: "string" },
                tz: { type: "string" }
              },
              required: ["kind"],
              additionalProperties: false
            }
          },
          required: ["name", "instruction", "sessionIds", "schedule"],
          additionalProperties: false
        }
      }
    }
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "manage_scheduled_job",
        description: "按 id 管理定时任务。action=enable|disable|remove。",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["enable", "disable", "remove"]
            },
            jobId: { type: "string" }
          },
          required: ["action", "jobId"],
          additionalProperties: false
        }
      }
    }
  }
];

export const schedulerToolHandlers: Record<string, ToolHandler> = {
  async list_scheduled_jobs(_toolCall, _args, context) {
    const denied = requireOwner(context.relationship, "Only owner can list scheduled jobs");
    if (denied) {
      return denied;
    }
    return JSON.stringify(await context.scheduler.listJobs());
  },
  async create_scheduled_job(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can create scheduled jobs");
    if (denied) {
      return denied;
    }
    const name = typeof args === "object" && args && "name" in args
      ? String((args as { name: unknown }).name).trim()
      : "";
    const instruction = typeof args === "object" && args && "instruction" in args
      ? String((args as { instruction: unknown }).instruction).trim()
      : "";
    const sessionIds = typeof args === "object" && args && "sessionIds" in args && Array.isArray((args as { sessionIds: unknown }).sessionIds)
      ? (args as { sessionIds: unknown[] }).sessionIds.map((item) => String(item))
      : [];
    const schedule = parseScheduledJobSchedule(
      typeof args === "object" && args && "schedule" in args
        ? (args as { schedule: unknown }).schedule
        : null,
      context.config.scheduler.defaultTimezone
    );
    if (!name || !instruction || sessionIds.length === 0) {
      return JSON.stringify({ error: "name, instruction, and sessionIds are required" });
    }
    if ("error" in schedule) {
      return JSON.stringify(schedule);
    }
    const knownSessions = new Set(context.sessionManager.listSessions().map((item) => item.id));
    const missingSessionIds = sessionIds.filter((item) => !knownSessions.has(item));
    if (missingSessionIds.length > 0) {
      return JSON.stringify({ error: "Some sessionIds do not exist", missingSessionIds });
    }
    const created = await context.scheduledJobStore.create({
      name,
      instruction,
      schedule,
      targets: sessionIds.map((item) => ({ sessionId: item }))
    });
    try {
      await context.scheduler.createJob(created);
    } catch (error: unknown) {
      await context.scheduledJobStore.remove(created.id);
      throw error;
    }
    return JSON.stringify(created);
  },
  async manage_scheduled_job(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can manage scheduled jobs");
    if (denied) {
      return denied;
    }
    const action = typeof args === "object" && args && "action" in args
      ? String((args as { action: unknown }).action)
      : "";
    const jobId = typeof args === "object" && args && "jobId" in args
      ? String((args as { jobId: unknown }).jobId)
      : "";
    if (!["enable", "disable", "remove"].includes(action)) {
      return JSON.stringify({ error: "action must be enable, disable, or remove" });
    }
    if (!jobId) {
      return JSON.stringify({ error: "jobId is required" });
    }

    if (action === "remove") {
      const removed = await context.scheduler.removeJob(jobId);
      return JSON.stringify({ removed, action, jobId });
    }
    const updated = await context.scheduler.setEnabled(jobId, action === "enable");
    return JSON.stringify(updated ?? { error: "Job not found" });
  }
};

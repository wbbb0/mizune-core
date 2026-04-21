import { s, type Infer } from "#data/schema/index.ts";

export const scheduledJobScheduleSchema = s.discriminatedUnion("kind", [
  s.object({
    kind: s.literal("delay").title("类型"),
    delayMs: s.number().int().positive().title("延迟毫秒")
  }).title("延时执行")
    .strict(),
  s.object({
    kind: s.literal("at").title("类型"),
    runAtMs: s.number().int().min(0).title("执行时间"),
    tz: s.string().trim().nonempty().title("时区")
  }).title("定时执行")
    .strict(),
  s.object({
    kind: s.literal("cron").title("类型"),
    expr: s.string().trim().nonempty().title("Cron 表达式"),
    tz: s.string().trim().nonempty().title("时区")
  }).title("Cron 执行")
    .strict()
]).title("计划")
  .describe("控制任务触发方式，可以是延时、定时或 Cron。");

export const scheduledJobRecordSchema = s.object({
  id: s.string().trim().nonempty().title("任务 ID"),
  name: s.string().trim().nonempty().title("名称"),
  enabled: s.boolean().title("启用"),
  createdAtMs: s.number().int().min(0).title("创建时间"),
  updatedAtMs: s.number().int().min(0).title("更新时间"),
  schedule: scheduledJobScheduleSchema,
  instruction: s.string().trim().nonempty().title("指令"),
  targets: s.array(s.object({
    sessionId: s.string().trim().nonempty().title("会话 ID")
  }).title("目标会话").strict())
    .title("目标会话")
    .describe("定义任务会把指令投递到哪些会话。")
    .min(1),
  state: s.object({
    nextRunAtMs: s.union([s.number().int().min(0), s.literal(null)]).title("下次运行时间").default(null),
    lastRunAtMs: s.union([s.number().int().min(0), s.literal(null)]).title("上次运行时间").default(null),
    lastRunStatus: s.union([s.enum(["ok", "error", "running"] as const), s.literal(null)]).title("上次运行结果").default(null),
    lastDurationMs: s.union([s.number().int().min(0), s.literal(null)]).title("上次耗时毫秒").default(null),
    lastError: s.union([s.string(), s.literal(null)]).title("上次错误").default(null),
    consecutiveErrors: s.number().int().min(0).title("连续错误次数")
  }).title("运行状态")
    .describe("记录最近运行结果与下一次计划时间。")
    .strict()
}).title("任务")
  .describe("定义一个可持久化的定时任务。")
  .strict();

export const scheduledJobFileSchema = s.object({
  version: s.literal(1).title("版本"),
  jobs: s.array(scheduledJobRecordSchema).title("任务列表").default([])
}).title("定时任务")
  .describe("保存全部已配置的定时任务。")
  .strict();

export type ScheduledJobRecord = Infer<typeof scheduledJobRecordSchema>;
export type ScheduledJobFile = Infer<typeof scheduledJobFileSchema>;

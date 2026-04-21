import { s, type Infer } from "#data/schema/index.ts";

export const browserPageRecoveryStateSchema = s.object({
  requestedUrl: s.string().title("请求 URL"),
  resolvedUrl: s.string().title("解析后 URL"),
  backend: s.enum(["playwright"] as const).title("后端"),
  title: s.union([s.string(), s.literal(null)]).title("页面标题").default(null),
  profileId: s.union([s.string(), s.literal(null)]).title("配置 ID").default(null)
}).title("浏览器页面")
  .describe("用于恢复浏览器页面的必要状态。")
  .strict();

export const shellSessionRecoveryStateSchema = s.object({
  command: s.string().title("命令"),
  cwd: s.string().title("工作目录"),
  shell: s.string().title("Shell"),
  tty: s.boolean().title("TTY"),
  login: s.boolean().title("登录 Shell")
}).title("Shell 会话")
  .describe("用于恢复 Shell 会话的启动参数。")
  .strict();

export const runtimeResourceRecordSchema = s.object({
  resourceId: s.string().trim().nonempty().title("资源 ID"),
  kind: s.enum(["browser_page", "shell_session"] as const).title("资源类型"),
  status: s.enum(["active", "expired", "closed", "unrecoverable"] as const).title("运行状态"),
  ownerSessionId: s.union([s.string().trim().nonempty(), s.literal(null)]).title("所属会话 ID").default(null),
  title: s.union([s.string(), s.literal(null)]).title("标题").default(null),
  description: s.union([s.string(), s.literal(null)]).title("说明").default(null),
  summary: s.string().title("摘要"),
  createdAtMs: s.number().int().min(0).title("创建时间"),
  lastAccessedAtMs: s.number().int().min(0).title("最近访问时间"),
  expiresAtMs: s.union([s.number().int().min(0), s.literal(null)]).title("过期时间").default(null),
  browserPage: browserPageRecoveryStateSchema.title("浏览器页面").optional(),
  shellSession: shellSessionRecoveryStateSchema.title("Shell 会话").optional()
}).title("资源")
  .describe("记录一个可恢复或已关闭的运行时资源。")
  .strict();

export const runtimeResourceFileSchema = s.object({
  resources: s.array(runtimeResourceRecordSchema)
    .title("资源列表")
    .describe("当前保存的浏览器页面和 Shell 会话恢复记录。")
    .default([])
}).title("运行时资源")
  .describe("保存可恢复运行时资源的持久化快照。")
  .strict();

export type RuntimeResourceFile = Infer<typeof runtimeResourceFileSchema>;

import { s, type Infer } from "#data/schema/index.ts";

export const setupStateSchema = s.object({
  state: s.enum(["needs_owner", "needs_persona", "ready"] as const).title("状态"),
  ownerPromptSentAt: s.union([s.number().int().min(0), s.literal(null)])
    .title("主人提示发送时间")
    .describe("首次给主人发送初始化提示时记录的时间，未发送时为 null。")
    .default(null),
  updatedAt: s.number().int().min(0).title("更新时间")
}).title("初始化状态")
  .describe("记录首次配置流程当前处于哪个阶段。")
  .strict();

export type SetupStateRecord = Infer<typeof setupStateSchema>;

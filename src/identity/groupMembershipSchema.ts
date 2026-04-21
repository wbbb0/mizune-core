import { s, type Infer } from "#data/schema/index.ts";

export const membershipEntrySchema = s.object({
  isMember: s.boolean().title("是否在群内"),
  verifiedAt: s.number().int().min(0).title("验证时间")
}).title("成员记录")
  .describe("记录某个用户在指定群里的最新成员状态。")
  .strict();

export const membershipFileSchema = s.object({
  version: s.literal(1).title("版本"),
  groups: s.record(
    s.string().trim().nonempty().title("群 ID"),
    s.record(
      s.string().trim().nonempty().title("用户 ID"),
      membershipEntrySchema
    ).title("成员列表")
      .describe("按用户 ID 缓存成员校验结果。")
      .default({})
  ).title("群列表")
    .describe("按群 ID 缓存成员校验结果。")
    .default({})
}).title("群成员缓存")
  .describe("保存群成员校验缓存，避免重复查询群成员状态。")
  .strict();

export type MembershipFile = Infer<typeof membershipFileSchema>;

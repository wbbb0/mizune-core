import { s, type Infer } from "#data/schema/index.ts";

export const pendingFriendRequestSchema = s.object({
  kind: s.literal("friend").title("类型"),
  flag: s.string().trim().nonempty().title("标记"),
  userId: s.string().trim().nonempty().title("用户 ID"),
  comment: s.string().title("附言").default(""),
  createdAt: s.number().int().min(0).title("创建时间")
}).title("好友请求")
  .describe("记录一个待处理的好友请求。")
  .strict();

export const pendingGroupRequestSchema = s.object({
  kind: s.literal("group").title("类型"),
  flag: s.string().trim().nonempty().title("标记"),
  userId: s.string().trim().nonempty().title("用户 ID"),
  groupId: s.string().trim().nonempty().title("群 ID"),
  subType: s.enum(["add", "invite"] as const).title("群请求类型"),
  comment: s.string().title("附言").default(""),
  createdAt: s.number().int().min(0).title("创建时间")
}).title("群请求")
  .describe("记录一个待处理的加群申请或群邀请。")
  .strict();

export const pendingRequestSchema = s.discriminatedUnion("kind", [
  pendingFriendRequestSchema,
  pendingGroupRequestSchema
]).title("请求");

export const requestFileSchema = s.object({
  version: s.literal(1).title("版本"),
  requests: s.array(pendingRequestSchema)
    .title("请求列表")
    .describe("等待审批或处理的好友请求与群请求。")
    .default([])
}).title("待处理请求")
  .describe("保存待处理的好友请求和群请求缓存。")
  .strict();

export type PendingFriendRequest = Infer<typeof pendingFriendRequestSchema>;
export type PendingGroupRequest = Infer<typeof pendingGroupRequestSchema>;
export type PendingRequest = Infer<typeof pendingRequestSchema>;
export type RequestFile = Infer<typeof requestFileSchema>;

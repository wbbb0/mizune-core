import { s, type Infer } from "#data/schema/index.ts";

export const pendingFriendRequestSchema = s.object({
  kind: s.literal("friend"),
  flag: s.string().trim().nonempty(),
  userId: s.string().trim().nonempty(),
  comment: s.string().default(""),
  createdAt: s.number().int().min(0)
}).strict();

export const pendingGroupRequestSchema = s.object({
  kind: s.literal("group"),
  flag: s.string().trim().nonempty(),
  userId: s.string().trim().nonempty(),
  groupId: s.string().trim().nonempty(),
  subType: s.enum(["add", "invite"] as const),
  comment: s.string().default(""),
  createdAt: s.number().int().min(0)
}).strict();

export const pendingRequestSchema = s.discriminatedUnion("kind", [
  pendingFriendRequestSchema,
  pendingGroupRequestSchema
]);

export const requestFileSchema = s.object({
  version: s.literal(1),
  requests: s.array(pendingRequestSchema).default([])
}).strict();

export type PendingFriendRequest = Infer<typeof pendingFriendRequestSchema>;
export type PendingGroupRequest = Infer<typeof pendingGroupRequestSchema>;
export type PendingRequest = Infer<typeof pendingRequestSchema>;
export type RequestFile = Infer<typeof requestFileSchema>;

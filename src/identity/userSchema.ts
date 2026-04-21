import { s, type Infer } from "#data/schema/index.ts";
import { userMemoryEntrySchema } from "#memory/userMemoryEntry.ts";
import type { Relationship } from "./relationship.ts";

export const persistedUserSchema = s.object({
  userId: s.string().trim().nonempty().title("用户 ID"),
  preferredAddress: s.string().trim().nonempty().title("称呼偏好").optional(),
  gender: s.string().trim().nonempty().title("性别").optional(),
  residence: s.string().trim().nonempty().title("居住地").optional(),
  timezone: s.string().trim().nonempty().title("时区").optional(),
  occupation: s.string().trim().nonempty().title("职业").optional(),
  profileSummary: s.string().trim().nonempty().title("资料摘要").optional(),
  relationshipNote: s.string().trim().nonempty().title("关系备注").optional(),
  memories: s.array(userMemoryEntrySchema)
    .title("长期记忆")
    .describe("记录会长期保留的用户事实、偏好和边界。")
    .default([]),
  specialRole: s.literal("npc").title("特殊角色").optional(),
  createdAt: s.number().int().min(0).title("创建时间")
}).title("用户")
  .describe("保存单个用户的基础资料和长期记忆。")
  .strict();

export const userStoreSchema = s.array(persistedUserSchema)
  .title("用户列表")
  .describe("按列表保存所有用户的基础资料和长期记忆。")
  .default([]);

export type PersistedUser = Infer<typeof persistedUserSchema>;
export type User = PersistedUser & {
  relationship: Relationship;
};

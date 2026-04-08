import { s, type Infer } from "#data/schema/index.ts";
import { memoryEntrySchema } from "#memory/memoryEntry.ts";
import type { Relationship } from "./relationship.ts";
import { specialRoleSchema } from "./specialRole.ts";

export const persistedUserSchema = s.object({
  userId: s.string().trim().nonempty(),
  nickname: s.string().trim().nonempty().optional(),
  preferredAddress: s.string().trim().nonempty().optional(),
  gender: s.string().trim().nonempty().optional(),
  residence: s.string().trim().nonempty().optional(),
  profileSummary: s.string().trim().nonempty().optional(),
  sharedContext: s.string().trim().nonempty().optional(),
  memories: s.array(memoryEntrySchema).default([]),
  specialRole: specialRoleSchema.default("none"),
  createdAt: s.number().int().min(0)
}).strict();

export const userStoreSchema = s.array(persistedUserSchema).default([]);

export type PersistedUser = Infer<typeof persistedUserSchema>;
export type User = PersistedUser & {
  relationship: Relationship;
};

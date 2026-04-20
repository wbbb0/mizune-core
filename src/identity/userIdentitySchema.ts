import { s, type Infer } from "#data/schema/index.ts";

export const userIdentityScopeSchema = s.enum(["private_user"] as const);

export const userIdentityRecordSchema = s.object({
  channelId: s.string().trim().nonempty(),
  scope: userIdentityScopeSchema,
  externalId: s.string().trim().nonempty(),
  internalUserId: s.string().trim().nonempty(),
  createdAt: s.number().int().min(0)
}).strict();

export const userIdentityStoreSchema = s.array(userIdentityRecordSchema).default([]);

export type UserIdentityScope = Infer<typeof userIdentityScopeSchema>;
export type UserIdentityRecord = Infer<typeof userIdentityRecordSchema>;

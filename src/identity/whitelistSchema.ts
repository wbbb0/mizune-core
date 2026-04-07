import { s, type Infer } from "#data/schema/index.ts";

export const whitelistEntrySchema = s.object({
  version: s.literal(2),
  ownerId: s.string().trim().nonempty().optional(),
  users: s.array(s.string().trim().nonempty()).default([]),
  groups: s.array(s.string().trim().nonempty()).default([])
}).strict();

export const legacyVersionedWhitelistEntrySchema = s.object({
  version: s.literal(1),
  users: s.array(s.string().trim().nonempty()).default([]),
  groups: s.array(s.string().trim().nonempty()).default([])
}).strict();

export const legacyWhitelistEntrySchema = s.object({
  users: s.array(s.string().trim().nonempty()).default([]),
  groups: s.array(s.string().trim().nonempty()).default([])
}).strict();

export const legacyOwnerRecordSchema = s.object({
  ownerQq: s.string().trim().nonempty()
}).strict();

export const whitelistFileSchema = s.union([
  whitelistEntrySchema,
  legacyVersionedWhitelistEntrySchema,
  legacyWhitelistEntrySchema
]);

export type WhitelistFile = Infer<typeof whitelistFileSchema>;

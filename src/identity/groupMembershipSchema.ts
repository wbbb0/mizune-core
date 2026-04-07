import { s, type Infer } from "#data/schema/index.ts";

export const membershipEntrySchema = s.object({
  isMember: s.boolean(),
  verifiedAt: s.number().int().min(0)
}).strict();

export const membershipFileSchema = s.object({
  version: s.literal(1),
  groups: s.record(
    s.string().trim().nonempty(),
    s.record(s.string().trim().nonempty(), membershipEntrySchema).default({})
  ).default({})
}).strict();

export type MembershipFile = Infer<typeof membershipFileSchema>;

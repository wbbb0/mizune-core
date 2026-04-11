import { s, type Infer } from "#data/schema/index.ts";

export const specialRoleSchema = s.literal("npc");

export type SpecialRole = Infer<typeof specialRoleSchema>;

import { s, type Infer } from "#data/schema/index.ts";

export const specialRoleSchema = s.enum(["none", "npc"] as const);

export type SpecialRole = Infer<typeof specialRoleSchema>;

import { s, type Infer } from "#data/schema/index.ts";

export const relationshipSchema = s.enum(["owner", "known"] as const);

export type Relationship = Infer<typeof relationshipSchema>;

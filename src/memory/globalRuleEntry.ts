import { randomUUID } from "node:crypto";
import { s, type Infer } from "#data/schema/index.ts";

export const globalRuleEntrySchema = s.object({
  id: s.string().trim().nonempty(),
  title: s.string().trim().nonempty(),
  content: s.string().trim().nonempty(),
  kind: s.enum(["workflow", "constraint", "preference", "other"] as const).default("workflow"),
  source: s.enum(["owner_explicit", "inferred"] as const).default("owner_explicit"),
  createdAt: s.number().int().min(0).default(() => Date.now()),
  updatedAt: s.number().int().min(0).default(() => Date.now())
}).strict();

export type GlobalRuleEntry = Infer<typeof globalRuleEntrySchema>;
export type GlobalRuleKind = GlobalRuleEntry["kind"];

export function createGlobalRuleEntry(input: {
  id?: string;
  title: string;
  content: string;
  kind?: GlobalRuleKind;
  source?: GlobalRuleEntry["source"];
  createdAt?: number;
  updatedAt?: number;
}): GlobalRuleEntry {
  const now = Date.now();
  return globalRuleEntrySchema.parse({
    id: input.id?.trim() || randomUUID(),
    title: input.title.trim(),
    content: input.content.trim(),
    kind: input.kind ?? "workflow",
    source: input.source ?? "owner_explicit",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  });
}

import { randomUUID } from "node:crypto";
import { s, type Infer } from "#data/schema/index.ts";

export const userMemoryEntrySchema = s.object({
  id: s.string().trim().nonempty(),
  title: s.string().trim().nonempty(),
  content: s.string().trim().nonempty(),
  kind: s.enum(["preference", "fact", "boundary", "habit", "relationship", "other"] as const).default("other"),
  source: s.enum(["user_explicit", "owner_explicit", "inferred"] as const).default("user_explicit"),
  createdAt: s.number().int().min(0).default(() => Date.now()),
  updatedAt: s.number().int().min(0).default(() => Date.now()),
  importance: s.number().int().min(1).max(5).optional(),
  lastUsedAt: s.number().int().min(0).optional()
}).strict();

export type UserMemoryEntry = Infer<typeof userMemoryEntrySchema>;
export type UserMemoryKind = UserMemoryEntry["kind"];

export function createUserMemoryEntry(input: {
  id?: string;
  title: string;
  content: string;
  kind?: UserMemoryKind;
  source?: UserMemoryEntry["source"];
  createdAt?: number;
  updatedAt?: number;
  importance?: number;
  lastUsedAt?: number;
}): UserMemoryEntry {
  const now = Date.now();
  return userMemoryEntrySchema.parse({
    id: input.id?.trim() || randomUUID(),
    title: input.title.trim(),
    content: input.content.trim(),
    kind: input.kind ?? "other",
    source: input.source ?? "user_explicit",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(input.lastUsedAt !== undefined ? { lastUsedAt: input.lastUsedAt } : {})
  });
}

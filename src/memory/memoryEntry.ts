import { randomUUID } from "node:crypto";
import { s, type Infer } from "#data/schema/index.ts";

export const memoryEntrySchema = s.object({
  id: s.string().trim().nonempty(),
  title: s.string().trim().nonempty(),
  content: s.string().trim().nonempty(),
  updatedAt: s.number().int().min(0)
}).strict();

export type MemoryEntry = Infer<typeof memoryEntrySchema>;

export function createMemoryEntry(input: {
  title: string;
  content: string;
  id?: string;
  updatedAt?: number;
}): MemoryEntry {
  const now = input.updatedAt ?? Date.now();
  return memoryEntrySchema.parse({
    id: input.id?.trim() || randomUUID(),
    title: input.title.trim(),
    content: input.content.trim(),
    updatedAt: now
  });
}

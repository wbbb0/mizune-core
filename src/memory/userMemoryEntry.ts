import { randomUUID } from "node:crypto";
import { s, type Infer } from "#data/schema/index.ts";

export const userMemoryEntrySchema = s.object({
  id: s.string().trim().nonempty().title("ID"),
  title: s.string().trim().nonempty().title("标题"),
  content: s.string().trim().nonempty().title("内容"),
  kind: s.enum(["preference", "fact", "boundary", "habit", "relationship", "other"] as const)
    .title("类型")
    .default("other"),
  source: s.enum(["user_explicit", "owner_explicit", "inferred"] as const)
    .title("来源")
    .default("user_explicit"),
  createdAt: s.number().int().min(0).title("创建时间").default(() => Date.now()),
  updatedAt: s.number().int().min(0).title("更新时间").default(() => Date.now()),
  importance: s.number().int().min(1).max(5).title("重要性").optional(),
  lastUsedAt: s.number().int().min(0).title("最近使用时间").optional()
}).title("记忆条目")
  .describe("保存一条可长期复用的用户记忆。")
  .strict();

export type UserMemoryEntry = Infer<typeof userMemoryEntrySchema>;
export type UserMemoryKind = UserMemoryEntry["kind"];

function inferUserMemoryKind(title: string, content: string): UserMemoryKind {
  const text = `${title}\n${content}`;
  if (/(不要|别|禁止|不能|边界|忌讳)/u.test(text)) {
    return "boundary";
  }
  if (/(偏好|喜欢|讨厌|希望|想要|爱吃|不喜欢)/u.test(text)) {
    return "preference";
  }
  if (/(关系|对象|伴侣|家人|朋友|同事)/u.test(text)) {
    return "relationship";
  }
  if (/(习惯|经常|常常|平时|作息)/u.test(text)) {
    return "habit";
  }
  if (/(住在|来自|生日|工作|职业|时区|学校|城市)/u.test(text)) {
    return "fact";
  }
  return "other";
}

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
    kind: input.kind ?? inferUserMemoryKind(input.title, input.content),
    source: input.source ?? "user_explicit",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(input.lastUsedAt !== undefined ? { lastUsedAt: input.lastUsedAt } : {})
  });
}

import { randomUUID } from "node:crypto";
import { s, type Infer } from "#data/schema/index.ts";

export const globalRuleEntrySchema = s.object({
  id: s.string().trim().nonempty().title("ID"),
  title: s.string().trim().nonempty().title("标题"),
  content: s.string().trim().nonempty().title("内容"),
  kind: s.enum(["workflow", "constraint", "preference", "other"] as const).title("类型").default("workflow"),
  source: s.enum(["owner_explicit", "inferred"] as const).title("来源").default("owner_explicit"),
  createdAt: s.number().int().min(0).title("创建时间").default(() => Date.now()),
  updatedAt: s.number().int().min(0).title("更新时间").default(() => Date.now())
}).title("全局规则")
  .describe("定义对所有会话生效的长期规则。")
  .strict();

export const globalRuleFileSchema = s.array(globalRuleEntrySchema)
  .title("全局规则列表")
  .describe("按列表保存可编辑的全局规则。")
  .default([]);

export type GlobalRuleEntry = Infer<typeof globalRuleEntrySchema>;
export type GlobalRuleKind = GlobalRuleEntry["kind"];

function inferGlobalRuleKind(title: string, content: string): GlobalRuleKind {
  const text = `${title}\n${content}`;
  if (/(不要|禁止|必须|仅在|严禁)/u.test(text)) {
    return "constraint";
  }
  if (/(偏好|优先|倾向|先给结论)/u.test(text)) {
    return "preference";
  }
  if (/(流程|步骤|默认|一般情况下|平时|所有任务)/u.test(text)) {
    return "workflow";
  }
  return "other";
}

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
    kind: input.kind ?? inferGlobalRuleKind(input.title, input.content),
    source: input.source ?? "owner_explicit",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  });
}

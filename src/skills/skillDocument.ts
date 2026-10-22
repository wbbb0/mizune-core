import { parse } from "yaml";
import { createHash } from "node:crypto";
export function estimateSkillTokens(text: string): number {
  // 中文逐字与其他文本按四字符估计，作为有界加载的保守预算。
  const chinese = text.match(/[\u2e80-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  return chinese + Math.ceil((text.length - chinese) / 4);
}
export function parseSkillDocument(document: string): {
  name: string;
  description: string;
  body: string;
} {
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u);
  if (!match)
    throw new Error("技能必须使用含 name、description 的标准 SKILL.md frontmatter。");
  const metadata: unknown = parse(match[1]!);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("技能 frontmatter 必须是对象。");
  const { name, description } = metadata as Record<string, unknown>;
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64)
    throw new Error("技能 name 必须为不超过64字符的小写字母、数字和连字符。");
  if (typeof description !== "string" || !description.trim() || description.length > 400)
    throw new Error("技能 description 必须为1至400字符。");
  if (!match[2]!.trim() || !/[\u3400-\u9fff]/u.test(match[2]!))
    throw new Error("技能正文必须包含中文说明。");
  if (document.length > 64000)
    throw new Error("技能文档过大。");
  return { name, description: description.trim(), body: match[2]!.trim() };
}
export function validateSkillId(id: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || id.length > 64)
    throw new Error("技能 ID 无效。");
}
export function validateSkillResources(resources: Record<string, string>): void {
  if (!resources || typeof resources !== "object" || Array.isArray(resources) || Object.keys(resources).length > 30)
    throw new Error("技能引用最多30份。");
  let size = 0;
  for (const [path, content] of Object.entries(resources)) {
    if (!/^references\/[a-zA-Z0-9_./-]+\.md$/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || typeof content !== "string")
      throw new Error("技能引用只能使用 references 下的 Markdown 相对路径。");
    size += content.length;
  }
  if (size > 256000)
    throw new Error("技能引用总大小超过限制。");
}
export function skillFingerprint(body: string): string {
  return createHash("sha256").update(body.replace(/\s+/gu, "").toLowerCase()).digest("hex");
}

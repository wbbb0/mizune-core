import type { BuiltinToolContext } from "./shared.ts";
import type { ChatFileRecord } from "#services/workspace/types.ts";

export function parseReferenceImageSelectors(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
    || value.some(selector => typeof selector !== "string" || !selector.trim())) {
    throw new Error("reference_images 必须包含 1 到 16 个图片资产引用");
  }
  return [...new Set(value.map(selector => (selector as string).trim()))];
}

/** Resolve exact instance asset identities only; paths and URLs never become file reads. */
export async function resolveStaticImageAsset(context: Pick<BuiltinToolContext, "chatFileStore" | "abortSignal">, selector: string): Promise<ChatFileRecord> {
  context.abortSignal?.throwIfAborted();
  const file = await context.chatFileStore.getFile(selector)
    ?? (await context.chatFileStore.listFiles()).find(candidate => candidate.fileRef === selector);
  if (!file || file.kind !== "image") throw new Error(`未找到静态图片资产：${selector}`);
  return file;
}

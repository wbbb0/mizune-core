import type { StickerRecord } from "./stickerStore.ts";

// 小型精选库使用中文二元字符 + 完整词匹配，不调用模型，不维护易失效的向量索引。
function tokens(text: string): Set<string> {
  const parts = text.normalize("NFKC").toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
  return new Set(parts.flatMap((part) => /\p{Script=Han}/u.test(part) && part.length > 1
    ? Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2)) : [part]));
}
export function searchStickers(items: StickerRecord[], query: string, limit: number): StickerRecord[] {
  const terms = tokens(query);
  const ranked = items.map((item) => {
    const m = item.metadata;
    const fields: Array<[string, number]> = [
      [m.description + " " + m.visibleText, 2], [m.situations.join(" "), 3],
      [m.emotions.join(" ") + " " + m.styles.join(" "), 3], [m.notes, 1]
    ];
    const score = fields.reduce((sum, [text, weight]) => {
      const words = tokens(text);
      return sum + [...terms].filter((term) => words.has(term)).length * weight;
    }, 0);
    return { item, score };
  });
  return ranked.filter(({ score }) => terms.size === 0 || score > 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    .slice(0, limit).map(({ item }) => item);
}

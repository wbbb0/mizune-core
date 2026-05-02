export function normalizedContextText(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function informativeContextTerms(text: string): Set<string> {
  const normalized = normalizedContextText(text);
  const terms = new Set<string>();
  for (const segment of normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[a-z0-9]+$/u.test(segment)) {
      if (segment.length >= 2 && !CONTEXT_TERM_STOP_WORDS.has(segment)) {
        terms.add(segment);
      }
      continue;
    }
    if (segment.length === 1) {
      if (!CONTEXT_TERM_STOP_WORDS.has(segment)) {
        terms.add(segment);
      }
      continue;
    }
    for (let index = 0; index < segment.length - 1; index += 1) {
      const term = segment.slice(index, index + 2);
      if (!CONTEXT_TERM_STOP_WORDS.has(term)) {
        terms.add(term);
      }
    }
  }
  return terms;
}

export function contextTermOverlapScore(left: string, right: string): number {
  const leftTerms = informativeContextTerms(left);
  const rightTerms = informativeContextTerms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return 0;
  }
  let matched = 0;
  for (const term of rightTerms) {
    if (leftTerms.has(term)) {
      matched += 1;
    }
  }
  return matched / rightTerms.size;
}

const CONTEXT_TERM_STOP_WORDS = new Set([
  "我",
  "你",
  "他",
  "她",
  "它",
  "的",
  "了",
  "和",
  "与",
  "及",
  "或",
  "在",
  "是",
  "为",
  "有",
  "把",
  "被",
  "这",
  "那",
  "一个",
  "一下",
  "用户",
  "助手",
  "the",
  "and",
  "or",
  "to",
  "of",
  "in",
  "is"
]);

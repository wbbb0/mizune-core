export const DEFAULT_TEXT_SIMILARITY_THRESHOLD = 0.62;

export function normalizeTextForSimilarity(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()、，。！？!?,.:;"'`]/g, "");
}

const TITLE_CANONICALIZATION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /^(用户)?称呼(偏好)?$/u, replacement: "称呼偏好" },
  { pattern: /^(用户)?叫法(偏好)?$/u, replacement: "称呼偏好" },
  { pattern: /^(输出顺序|回复顺序|回答顺序)$/u, replacement: "输出顺序" },
  { pattern: /^(说话方式|口吻|语气)$/u, replacement: "说话口吻" }
] as const;

export function normalizeTitleForDedup(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "");
  for (const rule of TITLE_CANONICALIZATION_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.replacement;
    }
  }
  return normalized;
}

export function bigramJaccardSimilarity(a: string, b: string): number {
  const bigrams = (str: string): Set<string> => {
    const result = new Set<string>();
    for (let i = 0; i < str.length - 1; i++) {
      result.add(str.slice(i, i + 2));
    }
    return result;
  };

  const left = bigrams(normalizeTextForSimilarity(a));
  const right = bigrams(normalizeTextForSimilarity(b));
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection++;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function isNearDuplicateText(
  source: string,
  candidates: string[],
  threshold: number = DEFAULT_TEXT_SIMILARITY_THRESHOLD
): boolean {
  const normalized = normalizeTextForSimilarity(source);
  return candidates.some((candidate) => {
    const target = normalizeTextForSimilarity(candidate);
    return normalized === target
      || normalized.includes(target)
      || target.includes(normalized)
      || bigramJaccardSimilarity(normalized, target) >= threshold;
  });
}

export interface DuplicateMatch<T> {
  item: T;
  similarityScore: number;
}

export function findBestDuplicateMatch<T>(
  source: string,
  candidates: T[],
  candidateText: (item: T) => string,
  threshold: number = DEFAULT_TEXT_SIMILARITY_THRESHOLD
): DuplicateMatch<T> | null {
  let best: DuplicateMatch<T> | null = null;
  const normalizedSource = normalizeTextForSimilarity(source);
  for (const candidate of candidates) {
    const text = candidateText(candidate);
    const score = bigramJaccardSimilarity(source, text);
    if (score >= threshold && (!best || score > best.similarityScore)) {
      best = { item: candidate, similarityScore: score };
    }
    const normalizedTarget = normalizeTextForSimilarity(text);
    if (
      normalizedSource === normalizedTarget
      || normalizedSource.includes(normalizedTarget)
      || normalizedTarget.includes(normalizedSource)
    ) {
      return {
        item: candidate,
        similarityScore: score
      };
    }
  }
  return best;
}

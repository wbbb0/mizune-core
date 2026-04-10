export const DEFAULT_TEXT_SIMILARITY_THRESHOLD = 0.62;

export function normalizeTextForSimilarity(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()、，。！？!?,.:;"'`]/g, "");
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

export function findBestDuplicateMatch<T>(
  source: string,
  candidates: T[],
  candidateText: (item: T) => string,
  threshold: number = DEFAULT_TEXT_SIMILARITY_THRESHOLD
): T | null {
  let best: { item: T; score: number } | null = null;
  for (const candidate of candidates) {
    const score = bigramJaccardSimilarity(source, candidateText(candidate));
    if (score >= threshold && (!best || score > best.score)) {
      best = { item: candidate, score };
    }
    const normalizedSource = normalizeTextForSimilarity(source);
    const normalizedTarget = normalizeTextForSimilarity(candidateText(candidate));
    if (
      normalizedSource === normalizedTarget
      || normalizedSource.includes(normalizedTarget)
      || normalizedTarget.includes(normalizedSource)
    ) {
      return candidate;
    }
  }
  return best?.item ?? null;
}

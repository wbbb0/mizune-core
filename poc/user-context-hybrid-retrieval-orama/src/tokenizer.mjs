export function createMixedLanguageTokenizer() {
  return {
    language: "mixed",
    normalizationCache: new Map(),
    tokenize(raw) {
      return tokenizeMixed(raw);
    },
  };
}

export function tokenizeMixed(text) {
  const tokens = [];
  const source = String(text ?? "").toLowerCase();
  for (const part of source.match(/[a-z0-9]+|[\u4e00-\u9fff]+/giu) ?? []) {
    if (/^[a-z0-9]+$/iu.test(part)) {
      tokens.push(part);
      continue;
    }
    if (part.length === 1) {
      tokens.push(part);
      continue;
    }
    for (let index = 0; index < part.length - 1; index += 1) {
      tokens.push(part.slice(index, index + 2));
    }
  }
  return tokens;
}

export function lexicalOverlap(queryText, candidateText) {
  const queryTokens = new Set(tokenizeMixed(queryText));
  const candidateTokens = new Set(tokenizeMixed(candidateText));
  if (queryTokens.size === 0 || candidateTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.size;
}

export function textOverlapRatio(textA, textB) {
  const tokensA = new Set(tokenizeMixed(textA));
  const tokensB = new Set(tokenizeMixed(textB));
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(tokensA.size, tokensB.size);
}

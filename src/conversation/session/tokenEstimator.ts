export interface TokenEstimationWeights {
  cjkTokens: number;
  nonAsciiTokens: number;
  asciiTokens: number;
}

// Lightweight heuristic used only when provider usage cannot be attributed.
export function estimateTokens(text: string, weights?: TokenEstimationWeights): number {
  const cjkTokens = weights?.cjkTokens ?? 2;
  const nonAsciiTokens = weights?.nonAsciiTokens ?? 1;
  const asciiTokens = weights?.asciiTokens ?? 0.25;
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0x4E00 && code <= 0x9FFF)
      || (code >= 0x3400 && code <= 0x4DBF)
      || (code >= 0x20000 && code <= 0x2A6DF)
      || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0x3000 && code <= 0x303F)
      || (code >= 0x30A0 && code <= 0x30FF)
      || (code >= 0x3040 && code <= 0x309F)
      || (code >= 0xFF00 && code <= 0xFFEF)
    ) {
      tokens += cjkTokens;
    } else if (code > 127) {
      tokens += nonAsciiTokens;
    } else {
      tokens += asciiTokens;
    }
  }
  return Math.ceil(tokens);
}

import { estimateTokens, type TokenEstimationWeights } from "#conversation/session/tokenEstimator.ts";

export function shouldUseToolResultReplayContent(input: {
  rawContent: string;
  replayContent: string;
  replaySafe: boolean | undefined;
  tokenEstimationWeights?: TokenEstimationWeights | undefined;
}): boolean {
  if (input.replaySafe === false) {
    return true;
  }
  return estimateTokens(input.replayContent, input.tokenEstimationWeights)
    < estimateTokens(input.rawContent, input.tokenEstimationWeights);
}

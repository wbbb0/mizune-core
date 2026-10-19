import { estimateTokens, type TokenEstimationWeights } from "#conversation/session/tokenEstimator.ts";
import type { LlmMessage } from "../provider/providerTypes.ts";

// Local budget estimates, not provider billing. Encoded media size is not a text token count.
// Reserve a nonzero per-part allowance; exact vision/audio tokenization depends on the model.
const IMAGE_TOKEN_ALLOWANCE = 1024;
const AUDIO_TOKEN_ALLOWANCE = 2048;

export function estimateMessageContentTokens(content: LlmMessage["content"], weights?: TokenEstimationWeights): number {
  if (typeof content === "string") return estimateTokens(content, weights);
  return content.reduce((total, part) => {
    switch (part.type) {
      case "text": return total + estimateTokens(part.text, weights);
      case "image_url": return total + IMAGE_TOKEN_ALLOWANCE;
      case "input_audio": return total + AUDIO_TOKEN_ALLOWANCE;
    }
  }, 0);
}

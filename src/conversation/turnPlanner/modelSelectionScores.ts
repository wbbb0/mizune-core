import { z } from "zod";

/** Only fixed model tiers and numeric metadata may enter logs or the transcript. */
export const modelSelectionScoresSchema = z.object({
  small: z.number().finite().min(0).max(1),
  large: z.number().finite().min(0).max(1),
  confidence: z.number().finite().min(0).max(1)
});

export type ModelSelectionScores = z.infer<typeof modelSelectionScoresSchema>;

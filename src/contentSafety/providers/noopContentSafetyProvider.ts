import type { ContentModerationProvider, ModerateMediaInput, ModerateTextInput, ModerationResult } from "../contentSafetyTypes.ts";

export function createNoopContentSafetyProvider(id = "noop"): ContentModerationProvider {
  const allow = (subject: string): ModerationResult => ({
    decision: "allow",
    reason: "allowed",
    labels: [],
    providerId: id,
    providerType: "noop",
    rawDecision: subject,
    checkedAtMs: Date.now()
  });
  return {
    id,
    type: "noop",
    capabilities: new Set(["text", "image", "emoji", "audio", "audio_transcript", "file", "local_media"]),
    async moderateText(_input: ModerateTextInput) {
      return allow("text");
    },
    async moderateMedia(_input: ModerateMediaInput) {
      return allow("media");
    }
  };
}

import type { AppConfig } from "#config/config.ts";
import type {
  ContentModerationProvider,
  ModerateMediaInput,
  ModerateTextInput,
  ModerationResult
} from "../contentSafetyTypes.ts";

type ProviderConfig = AppConfig["contentSafety"]["providers"][string];

export function createKeywordContentSafetyProvider(id: string, providerConfig: ProviderConfig): ContentModerationProvider {
  const blockedTextKeywords = providerConfig.blockedTextKeywords.map((item) => item.toLowerCase());
  const blockedMediaNameKeywords = providerConfig.blockedMediaNameKeywords.map((item) => item.toLowerCase());
  return {
    id,
    type: "keyword",
    capabilities: new Set(["text", "image", "emoji", "audio", "file", "local_media", "audio_transcript"]),
    async moderateText(input: ModerateTextInput) {
      const normalized = input.text.toLowerCase();
      const keyword = blockedTextKeywords.find((item) => normalized.includes(item));
      return keyword ? blockResult(id, "text", keyword) : allowResult(id, "text");
    },
    async moderateMedia(input: ModerateMediaInput) {
      const normalized = `${input.fileId ?? ""} ${input.sourceName ?? ""}`.toLowerCase();
      const keyword = blockedMediaNameKeywords.find((item) => normalized.includes(item));
      return keyword ? blockResult(id, "media", keyword) : allowResult(id, "media");
    }
  };
}

function allowResult(providerId: string, rawDecision: string): ModerationResult {
  return {
    decision: "allow",
    reason: "allowed",
    labels: [],
    providerId,
    providerType: "keyword",
    rawDecision,
    checkedAtMs: Date.now()
  };
}

function blockResult(providerId: string, subject: string, keyword: string): ModerationResult {
  return {
    decision: "block",
    reason: "命中本地内容安全关键词",
    labels: [{
      label: "keyword_match",
      category: subject,
      riskLevel: "high",
      confidence: 100,
      providerReason: keyword
    }],
    providerId,
    providerType: "keyword",
    rawDecision: "keyword_block",
    checkedAtMs: Date.now()
  };
}

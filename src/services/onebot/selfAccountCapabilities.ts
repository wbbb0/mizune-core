import type { AppConfig } from "#config/config.ts";

export type OneBotSelfAccountCapability =
  | "view"
  | "nickname_update"
  | "signature_update"
  | "avatar_update";

export function hasOneBotSelfAccountCapability(
  config: AppConfig,
  capability: OneBotSelfAccountCapability
): boolean {
  if (!config.onebot.enabled || config.onebot.provider !== "napcat") {
    return false;
  }
  if (capability === "avatar_update") {
    return config.chatFiles.enabled;
  }
  return true;
}

export function describeOneBotSelfAccountCapabilityUnavailable(
  config: AppConfig,
  capability: OneBotSelfAccountCapability
): string | null {
  if (hasOneBotSelfAccountCapability(config, capability)) {
    return null;
  }
  if (!config.onebot.enabled) {
    return "OneBot is disabled";
  }
  if (config.onebot.provider !== "napcat") {
    return "OneBot self account management requires onebot.provider=napcat";
  }
  if (capability === "avatar_update" && !config.chatFiles.enabled) {
    return "self account avatar update requires chatFiles.enabled=true";
  }
  return "OneBot self account capability is unavailable";
}

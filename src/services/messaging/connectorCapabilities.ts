import type { AppConfig } from "#config/config.ts";
import { parseSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { SessionDelivery } from "#conversation/session/sessionTypes.ts";

export type ConnectorCapability =
  | "message.read_native" | "message.file.read" | "message.targets.read" | "message.delegate"
  | "group.info.read" | "group.members.read" | "group.files.read" | "group.announcements.read"
  | "account.profile.read" | "account.profile.write" | "account.avatar.write"
  | "contacts.read" | "requests.read" | "requests.respond" | "chat.permission.write"
  | "sticker.native_collection.read"
  | "media.image.send" | "media.audio.send" | "media.file.send";
export interface ConnectorCapabilityContext {
  sessionId?: string | undefined;
  replyDelivery?: SessionDelivery | undefined;
}

/** Static connector facts only: socket state, quotas and reply permits never change this set. */
export function resolveConnectorCapabilities(config: AppConfig, context: ConnectorCapabilityContext): ReadonlySet<ConnectorCapability> {
  const capabilities = new Set<ConnectorCapability>();
  const identity = parseSessionIdentity(context.sessionId ?? "");
  if (identity.kind === "unknown") return capabilities;
  if (identity.kind === "web" || context.replyDelivery === "web") {
    capabilities.add("media.image.send"); capabilities.add("media.audio.send"); capabilities.add("media.file.send");
  }
  if (identity.kind === "web") {
    capabilities.add("media.image.send"); capabilities.add("media.audio.send"); capabilities.add("media.file.send");
    return capabilities;
  }
  if (identity.source === "qq_official") {
    if (!config.qqOfficial.enabled || identity.channelId !== `qq_official.${config.qqOfficial.appId}`) return capabilities;
    capabilities.add("media.image.send"); capabilities.add("media.audio.send"); capabilities.add("media.file.send");
    return capabilities;
  }
  if (!config.onebot.enabled || identity.channelId !== config.configRuntime.instanceName) return capabilities;
  for (const capability of ["message.read_native", "message.file.read", "message.targets.read", "message.delegate", "contacts.read", "requests.read", "requests.respond", "chat.permission.write", "media.image.send", "media.audio.send"] as const) capabilities.add(capability);
  if (identity.kind === "group") {
    capabilities.add("group.info.read"); capabilities.add("group.members.read");
    if (config.onebot.provider === "napcat") { capabilities.add("group.files.read"); capabilities.add("group.announcements.read"); }
  }
  if (config.onebot.provider === "napcat") {
    for (const capability of ["account.profile.read", "account.profile.write", "sticker.native_collection.read", "media.file.send"] as const) capabilities.add(capability);
    if (config.chatFiles.enabled) capabilities.add("account.avatar.write");
  }
  if (context.replyDelivery === "web") capabilities.add("media.file.send");
  return capabilities;
}
export function hasConnectorCapability(config: AppConfig, context: ConnectorCapabilityContext, capability: ConnectorCapability): boolean {
  return resolveConnectorCapabilities(config, context).has(capability);
}
export function describeConnectorContext(context: ConnectorCapabilityContext) {
  const identity = parseSessionIdentity(context.sessionId ?? "");
  return { source: identity.kind === "unknown" ? null : identity.source, connectionId: "channelId" in identity ? identity.channelId : null, chatType: identity.kind };
}

export function mediaSendCapability(kind: string): ConnectorCapability {
  return kind === "image" || kind === "animated_image" ? "media.image.send" : kind === "audio" ? "media.audio.send" : "media.file.send";
}

export type ImageCaptionPrefetchPolicy = "off" | "eager";

export function resolveIncomingMessageCaptionPrefetchPolicy(input: {
  shouldTriggerResponse: boolean;
}): ImageCaptionPrefetchPolicy {
  return input.shouldTriggerResponse ? "eager" : "off";
}

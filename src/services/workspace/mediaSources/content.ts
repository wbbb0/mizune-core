import { parseSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { MessageContentPart, PersistedMessageContentPart } from "#messages/contentParts.ts";
import type { MediaResolution, MediaScope } from "./types.ts";

export function mediaScopeForSession(sessionId: string): MediaScope {
  const identity = parseSessionIdentity(sessionId);
  return { sessionId, connectionId: identity.kind === "group" || identity.kind === "private" ? identity.channelId : identity.source };
}

export function mediaResolutionPart(resolution: MediaResolution): PersistedMessageContentPart {
  const { kind, file } = resolution;
  return kind === "image" || kind === "emoji"
    ? { kind, mediaRef: resolution.ref, fileId: file.fileId, sourceName: file.sourceName, mimeType: file.mimeType }
    : { kind: "asset_file", mediaRef: resolution.ref, fileId: file.fileId, fileKind: file.kind, sourceName: file.sourceName,
        mimeType: file.mimeType, sizeBytes: file.sizeBytes };
}

export function resolvePendingMediaParts<T extends MessageContentPart>(
  parts: readonly T[], resolutions: ReadonlyMap<string, MediaResolution>
): MessageContentPart[] {
  return parts.map(part => {
    if (part.kind === "pending_media") return resolutions.has(part.mediaRef) ? mediaResolutionPart(resolutions.get(part.mediaRef)!) : part;
    if ((part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.mediaRef && resolutions.has(part.mediaRef)) {
      return mediaResolutionPart(resolutions.get(part.mediaRef)!);
    }
    if (part.kind === "embedded_message") return { ...part, parts: resolvePendingMediaParts(part.parts, resolutions) };
    return part;
  });
}

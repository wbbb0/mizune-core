import type { SessionToolRuntimeAccess } from "#conversation/session/sessionCapabilities.ts";
import { walkMessageContentParts } from "#messages/contentParts.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { trustedReferenceParts } from "#services/messaging/trustedReferences.ts";

/** Precision repair is not authorization. Only expand actual native references from this session. */
export function assertKnownOneBotReference(
  sessions: Pick<SessionToolRuntimeAccess, "getSession">, sessionId: string, kind: "reply" | "forward", id: string
): void {
  const identity = parseChatSessionIdentity(sessionId);
  if (!identity || identity.source !== "onebot") throw new Error("当前会话不提供 OneBot 引用读取");
  const session = sessions.getSession(sessionId);
  const known = new Set<string>();
  for (const item of session.internalTranscript) {
    if (item.runtimeExcluded) continue;
    if (item.kind === "user_message" || item.kind === "user_media_message") {
      if (kind === "reply" && item.replyMessageId) known.add(item.replyMessageId);
      if (kind === "forward" && item.kind === "user_message") for (const value of item.forwardIds ?? []) known.add(value);
    }
    for (const part of walkMessageContentParts(trustedReferenceParts(item))) {
      if (part.kind === kind) known.add(part.kind === "reply" ? part.messageId : part.forwardId);
      if (part.kind === "embedded_message" && part.relation === kind && part.messageId) known.add(part.messageId);
    }
  }
  if (!known.has(id)) throw new Error("该引用不在当前会话可见消息中");
}

export function assertKnownMediaReference(sessions: Pick<SessionToolRuntimeAccess, "getSession">, sessionId: string, ref: string): void {
  const session = sessions.getSession(sessionId);
  if (!session.internalTranscript.some(item => [...walkMessageContentParts(trustedReferenceParts(item))]
    .some(part => (part.kind === "pending_media" || part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.mediaRef === ref))) {
    throw new Error("媒体引用不在当前会话可见消息中");
  }
}

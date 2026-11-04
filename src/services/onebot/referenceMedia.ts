import { importIncomingContent } from "#services/messaging/importIncomingContent.ts";
import { mediaScopeForSession } from "#services/workspace/mediaSources/content.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";

/** Shared asset import for native references, with the current actor retained as the owner. */
export async function importReferenceMedia(
  dependencies: Parameters<typeof importIncomingContent>[0],
  actor: { sessionId: string; userId: string; senderName: string },
  parts: MessageContentPart[]
) {
  const scope = mediaScopeForSession(actor.sessionId);
  const parsed = actor.sessionId.match(/^[^:]+:(p|g):(.+)$/);
  if (!parsed) throw new Error("引用需要明确的聊天会话");
  return importIncomingContent(dependencies, {
    source: "onebot", channelId: scope.connectionId, chatType: parsed[1] === "g" ? "group" : "private",
    ...(parsed[1] === "g" ? { groupId: parsed[2]! } : { externalUserId: parsed[2]! }),
    userId: actor.userId, senderName: actor.senderName, text: "", contentParts: parts,
    images: [], emojiSources: [], audioSources: [], audioIds: [], imageIds: [], emojiIds: [],
    forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false
  }, actor.userId);
}

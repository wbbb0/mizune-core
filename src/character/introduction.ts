import type { SessionDirectCommandAccess } from "#conversation/session/sessionCapabilities.ts";
import { characterRepository } from "./repository.ts";

export function enqueueCharacterIntroduction(input: {
  dataDir: string;
  sessionId: string;
  userId: string;
  sessionManager: Pick<SessionDirectCommandAccess, "appendSyntheticPendingMessage">;
  flushSession: (id: string, options?: { skipReplyGate?: boolean }) => void;
  persist: () => void;
}): void {
  const store = characterRepository(input.dataDir);
  if (!store.claimIntroduction(input.sessionId)) return;
  input.sessionManager.appendSyntheticPendingMessage(input.sessionId, {
    chatType: "private", userId: input.userId, senderName: "配置流程",
    text: "【系统配置引导事件】刚进入当前配置阶段。请主动说明正在配置什么、需要哪些信息，并给出第一组推荐；说明可以跳过和使用 .confirm 保存。这不是玩家的剧情台词。",
    images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [], attachments: [], forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false
  });
  input.persist();
  input.flushSession(input.sessionId, { skipReplyGate: true });
}

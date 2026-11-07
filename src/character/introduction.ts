import type { SessionDirectCommandAccess } from "#conversation/session/sessionCapabilities.ts";
import type { SessionMessage, SessionState } from "#conversation/session/sessionTypes.ts";
import type { ToolActorAuthorization } from "#services/messaging/toolActorAuthorization.ts";
import type { CharacterDraft } from "./model.ts";
import { characterRepository } from "./repository.ts";

export function characterIntroductionDirective(draft: CharacterDraft | null): string | null {
  return draft && draft.introduction !== "delivered"
    ? `本轮刚进入角色配置 ${draft.stage} 阶段。请主动说明正在配置什么、需要哪些信息，并给出第一组推荐；说明可以跳过和使用 .confirm 保存。这是配置引导，不是玩家的剧情台词。`
    : null;
}

/** Stale queued events never introduce or authorize another draft. Reply permits are transient. */
export function isCurrentCharacterIntroduction(message: SessionMessage, draft: CharacterDraft | null, session: Pick<SessionState, "operationMode">): boolean {
  return !message.intent || (draft?.id === message.intent.draftId && draft.introduction !== "delivered"
    && session.operationMode.kind === "character_config" && session.operationMode.stage === draft.stage);
}

export function enqueueCharacterIntroduction(input: {
  dataDir: string;
  sessionId: string;
  userId: string;
  actorAuthorization: ToolActorAuthorization;
  replyContext?: SessionMessage["replyContext"];
  sessionManager: Pick<SessionDirectCommandAccess, "appendSyntheticPendingMessage" | "getSession" | "hasActiveResponse">;
  flushSession: (id: string, options?: { skipReplyGate?: boolean }) => void;
  persist: () => void;
}): void {
  if (input.actorAuthorization.internalUserId !== input.userId) throw new Error("配置引导的请求身份不匹配");
  const draft = characterRepository(input.dataDir).draft(input.sessionId);
  if (!draft || !characterIntroductionDirective(draft)) return;
  const session = input.sessionManager.getSession(input.sessionId);
  if (session.type !== "private" || input.userId !== "owner") throw new Error("角色配置引导仅允许 owner 私聊");
  if (input.sessionManager.hasActiveResponse(input.sessionId)
    || session.pendingMessages.some(message => message.intent?.draftId === draft.id)) return;
  input.sessionManager.appendSyntheticPendingMessage(input.sessionId, {
    intent: { kind: "character_introduction", draftId: draft.id },
    actorAuthorization: input.actorAuthorization,
    ...(input.replyContext ? { replyContext: input.replyContext } : {}),
    chatType: "private", userId: input.userId, senderName: "配置流程", text: "", images: []
  });
  input.persist();
  input.flushSession(input.sessionId, { skipReplyGate: true });
}

import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";

interface GenerationTypingTarget {
  delivery: "onebot" | "web";
  chatType: "private" | "group";
  userId: string;
  groupId?: string;
}

export function createGenerationTypingWindow(
  deps: {
    oneBotClient: Pick<OneBotClient, "setTyping">;
    sessionManager: Pick<SessionManager, "getSession">;
  },
  input: {
    sessionId: string;
    responseEpoch: number;
    target: GenerationTypingTarget;
  }
) {
  let started = false;

  const resolveTypingTarget = () => {
    const parsedSession = parseChatSessionIdentity(input.sessionId);
    if (parsedSession?.kind === "private") {
      return {
        chatType: "private" as const,
        userId: parsedSession.userId
      };
    }
    return {
      chatType: input.target.chatType,
      userId: input.target.userId,
      ...(input.target.groupId ? { groupId: input.target.groupId } : {})
    };
  };

  const startIfNeeded = async (): Promise<void> => {
    if (started || input.target.delivery !== "onebot") {
      return;
    }
    if (deps.sessionManager.getSession(input.sessionId).responseEpoch !== input.responseEpoch) {
      return;
    }
    const target = resolveTypingTarget();
    started = await deps.oneBotClient.setTyping({
      enabled: true,
      ...target
    });
  };

  const stopIfStarted = async (): Promise<void> => {
    if (!started || input.target.delivery !== "onebot") {
      return;
    }
    if (deps.sessionManager.getSession(input.sessionId).responseEpoch !== input.responseEpoch) {
      return;
    }

    started = false;
    const target = resolveTypingTarget();
    await deps.oneBotClient.setTyping({
      enabled: false,
      ...target
    });
  };

  return {
    startIfNeeded,
    stopIfStarted,
    hasStarted: () => started
  };
}

import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";

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

  const startIfNeeded = async (): Promise<void> => {
    if (started || input.target.delivery !== "onebot") {
      return;
    }
    if (deps.sessionManager.getSession(input.sessionId).responseEpoch !== input.responseEpoch) {
      return;
    }
    started = await deps.oneBotClient.setTyping({
      enabled: true,
      chatType: input.target.chatType,
      userId: input.target.userId,
      ...(input.target.groupId ? { groupId: input.target.groupId } : {})
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
    await deps.oneBotClient.setTyping({
      enabled: false,
      chatType: input.target.chatType,
      userId: input.target.userId,
      ...(input.target.groupId ? { groupId: input.target.groupId } : {})
    });
  };

  return {
    startIfNeeded,
    stopIfStarted,
    hasStarted: () => started
  };
}

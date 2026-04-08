import type { Logger } from "pino";
import { resolvePostRouterSetupDecision, resolvePreRouterSetupDecision } from "./messageAdmission.ts";
import type { MessageEventHandlerDeps, MessageHandlerServices, MessageProcessingContext } from "./messageHandlerTypes.ts";

export async function handlePreRouterDecision(
  services: Pick<MessageHandlerServices, "logger" | "oneBotClient">,
  handleDirectCommand: MessageEventHandlerDeps["handleDirectCommand"],
  decision: ReturnType<typeof resolvePreRouterSetupDecision>
): Promise<boolean> {
  if (decision.kind === "handle_bootstrap_command") {
    services.logger.info(
      { sessionId: decision.sessionId, command: decision.command.name },
      "direct_command_received"
    );
    await handleDirectCommand(decision);
    return true;
  }

  if (decision.kind === "reject_private_before_owner_bound") {
    await services.oneBotClient.sendText({
      userId: decision.userId,
      text: decision.text
    });
    return true;
  }

  return false;
}

export async function handlePostRouterSetupDecision(
  services: Pick<MessageHandlerServices, "logger" | "whitelistStore">,
  context: MessageProcessingContext,
  sendImmediateText: MessageEventHandlerDeps["sendImmediateText"]
): Promise<boolean> {
  const ownerId = services.whitelistStore.getOwnerId();
  const decision = resolvePostRouterSetupDecision({
    setupState: context.setupState.state,
    chatType: context.enrichedMessage.chatType,
    relationship: context.user.relationship,
    ...(ownerId ? { ownerId } : {})
  });

  if (decision.kind === "allow") {
    return false;
  }

  if (decision.kind === "ignore_during_setup") {
    services.logger.info(
      {
        sessionId: context.session.id,
        chatType: context.enrichedMessage.chatType,
        userId: context.enrichedMessage.userId,
        groupId: context.enrichedMessage.groupId,
        relationship: context.user.relationship
      },
      "message_ignored_during_setup"
    );
    return true;
  }

  await sendImmediateText({
    sessionId: context.session.id,
    userId: context.enrichedMessage.userId,
    text: decision.text,
    recordInHistory: false,
    transcriptItem: {
      kind: "status_message",
      llmVisible: false,
      role: "assistant",
      statusType: "system",
      content: decision.text,
      timestampMs: Date.now()
    },
    recordForRetract: false
  });
  services.logger.info(
    {
      sessionId: context.session.id,
      userId: context.enrichedMessage.userId,
      relationship: context.user.relationship,
      setupState: context.setupState.state
    },
    "private_message_blocked_during_setup"
  );
  return true;
}

export function logDirectCommandFailed(
  logger: Logger,
  error: unknown,
  sessionId: string,
  commandName: string
): void {
  logger.error({ error, sessionId, command: commandName }, "direct_command_failed");
}

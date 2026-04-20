import type { Logger } from "pino";
import { resolveDispatchableDirectCommand } from "./directCommands.ts";
import type {
  DirectCommandInput,
  MessageEventHandlerDeps,
  MessageHandlerServices,
  MessageProcessingContext
} from "./messageHandlerTypes.ts";

export function resolveChatDirectCommand(
  context: MessageProcessingContext
): DirectCommandInput["command"] | null {
  return resolveDispatchableDirectCommand({
    phase: "chat",
    setupState: context.setupState.state,
    chatType: context.enrichedMessage.chatType,
    relationship: context.user.relationship,
    isAtMentioned: context.enrichedMessage.isAtMentioned,
    text: context.enrichedMessage.text,
    hasImages: context.enrichedMessage.images.length > 0,
    hasForwards: context.enrichedMessage.forwardIds.length > 0,
    hasAudio: context.enrichedMessage.audioSources.length > 0,
    sessionModeId: context.session.modeId
  });
}

export async function dispatchChatDirectCommand(
  logger: Logger,
  sessionManager: MessageHandlerServices["sessionManager"],
  persistSession: MessageEventHandlerDeps["persistSession"],
  handleDirectCommand: MessageEventHandlerDeps["handleDirectCommand"],
  context: MessageProcessingContext,
  command: DirectCommandInput["command"]
): Promise<void> {
  logger.info({ sessionId: context.session.id, command: command.name }, "direct_command_received");
  sessionManager.appendInternalTranscript(context.session.id, {
    kind: "direct_command",
    llmVisible: false,
    direction: "input",
    role: "user",
    commandName: command.name,
    content: context.enrichedMessage.text,
    timestampMs: Date.now()
  });
  persistSession(context.session.id, "direct_command_input_recorded");
  await handleDirectCommand({
    command,
    sessionId: context.session.id,
    incomingMessage: {
      ...(context.enrichedMessage.channelId ? { channelId: context.enrichedMessage.channelId } : {}),
      chatType: context.enrichedMessage.chatType,
      userId: context.enrichedMessage.userId,
      ...(context.enrichedMessage.externalUserId ? { externalUserId: context.enrichedMessage.externalUserId } : {}),
      ...(context.enrichedMessage.groupId ? { groupId: context.enrichedMessage.groupId } : {}),
      relationship: context.user.relationship
    }
  });
}

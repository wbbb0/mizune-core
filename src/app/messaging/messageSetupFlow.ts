import { characterRepository } from "../../character/repository.ts";
import type { Logger } from "pino";
import { requireSessionModeDefinition } from "#modes/registry.ts";
import type { MessageEventHandlerDeps, MessageHandlerServices, MessageProcessingContext } from "./messageHandlerTypes.ts";
import { resolvePostRouterSetupDecision, resolvePreRouterSetupDecision } from "./messageAdmission.ts";
import type { SessionModeSetupContext } from "#modes/types.ts";
import { createEmptyScenarioProfile } from "#modes/scenarioHost/profileSchema.ts";
import { isScenarioSetupComplete } from "#modes/scenarioHost/types.ts";

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

export async function ensureAutomaticSetupOperationMode(
  services: Pick<
    MessageHandlerServices,
    "config" | "sessionManager" | "globalProfileReadinessStore" | "personaStore" | "rpProfileStore" | "scenarioHostStateStore"
  >,
  context: MessageProcessingContext,
  persistSession: MessageEventHandlerDeps["persistSession"]
): Promise<void> {
  const currentOperationMode = services.sessionManager.getOperationMode(context.session.id);
  if (currentOperationMode.kind !== "normal") {
    return;
  }

  if (context.enrichedMessage.chatType !== "private" || context.user.relationship !== "owner") return;
  const draft = characterRepository(services.config.dataDir).ensureSetup(context.session.id, context.session.modeId);
  if (draft) {
    services.sessionManager.setOperationMode(context.session.id, { kind: "character_config", stage: draft.stage });
    persistSession(context.session.id, "character_setup_entered");
    return;
  }
  if (context.session.modeId === "scenario_host") {
    const state = await services.scenarioHostStateStore.ensureForSession(context.session);
    if (!isScenarioSetupComplete(state)) {
      services.sessionManager.setOperationMode(context.session.id, { kind: "mode_setup", modeId: "scenario_host", draft: state.profile });
      persistSession(context.session.id, "scenario_setup_entered");
    }
  }
}

export async function handlePostRouterSetupDecision(
  services: Pick<MessageHandlerServices, "logger" | "userIdentityStore">,
  context: MessageProcessingContext,
  sendImmediateText: MessageEventHandlerDeps["sendImmediateText"]
): Promise<boolean> {
  const decision = resolvePostRouterSetupDecision({
    setupState: context.setupState.state,
    chatType: context.enrichedMessage.chatType,
    relationship: context.user.relationship,
    ownerBound: await services.userIdentityStore.hasOwnerIdentity()
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
    ...(context.enrichedMessage.externalUserId ? { externalUserId: context.enrichedMessage.externalUserId } : {}),
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

import type { Logger } from "pino";
import { requireSessionModeDefinition } from "#modes/registry.ts";
import type { MessageEventHandlerDeps, MessageHandlerServices, MessageProcessingContext } from "./messageHandlerTypes.ts";
import { resolvePostRouterSetupDecision, resolvePreRouterSetupDecision } from "./messageAdmission.ts";
import type { SessionModeSetupContext } from "#modes/types.ts";

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
    "sessionManager" | "globalProfileReadinessStore" | "personaStore" | "rpProfileStore" | "scenarioProfileStore"
  >,
  context: MessageProcessingContext,
  persistSession: MessageEventHandlerDeps["persistSession"]
): Promise<void> {
  const currentOperationMode = services.sessionManager.getOperationMode(context.session.id);
  if (currentOperationMode.kind !== "normal") {
    return;
  }

  const modeDef = requireSessionModeDefinition(context.session.modeId);
  if (!modeDef.setupPhase) {
    return;
  }

  const readiness = await services.globalProfileReadinessStore.get();
  const setupContext: SessionModeSetupContext = {
    personaReady: readiness.persona === "ready",
    modeProfileReady: context.session.modeId === "rp_assistant"
      ? readiness.rp === "ready"
      : context.session.modeId === "scenario_host"
        ? readiness.scenario === "ready"
        : true,
    operationMode: currentOperationMode,
    chatType: context.enrichedMessage.chatType,
    relationship: context.user.relationship
  };
  const nextOperationKind = modeDef.setupPhase.resolveOperationModeKind(setupContext);
  if (nextOperationKind === "persona_setup") {
    services.sessionManager.setOperationMode(context.session.id, {
      kind: "persona_setup",
      draft: services.personaStore.createEmpty()
    });
    persistSession(context.session.id, "persona_setup_mode_auto_entered");
    return;
  }
  if (nextOperationKind === "mode_setup" && context.session.modeId === "rp_assistant") {
    services.sessionManager.setOperationMode(context.session.id, {
      kind: "mode_setup",
      modeId: "rp_assistant",
      draft: services.rpProfileStore.createEmpty()
    });
    persistSession(context.session.id, "rp_setup_mode_auto_entered");
    return;
  }
  if (nextOperationKind === "mode_setup" && context.session.modeId === "scenario_host") {
    services.sessionManager.setOperationMode(context.session.id, {
      kind: "mode_setup",
      modeId: "scenario_host",
      draft: services.scenarioProfileStore.createEmpty()
    });
    persistSession(context.session.id, "scenario_setup_mode_auto_entered");
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

import type { IncomingMessageReceiptStore } from "#data/state/incomingMessageReceiptStore.ts";
import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
import type { QqOfficialIncoming } from "#services/qqOfficial/eventDecoder.ts";
import type { createRuntimeMessageIngress } from "./messageIngress.ts";
import { isOfficialMessageAllowed } from "./officialMessageAdmission.ts";

type AdmissionArguments = Parameters<typeof isOfficialMessageAllowed>;

/** Claim durable delivery state before commands, media imports or conversation changes. */
export async function receiveOfficialMessage(
  dependencies: {
    receipts: Pick<IncomingMessageReceiptStore, "claim">;
    whitelistEnabled: boolean;
    allowGroupContext: boolean;
    whitelist: AdmissionArguments[2];
    identities: AdmissionArguments[3];
    handleIncomingMessage: ReturnType<typeof createRuntimeMessageIngress>["handleIncomingMessage"];
  },
  event: QqOfficialIncoming
): Promise<void> {
  const message: ParsedIncomingMessage = { ...event.message, contextOnly: event.contextOnly };
  if (!isOfficialMessageAllowed(message, dependencies.whitelistEnabled, dependencies.whitelist, dependencies.identities,
    { allowGroupContext: dependencies.allowGroupContext })) return;

  const source = event.message.sourceRef;
  const targetId = message.chatType === "group"
    ? message.groupId
    : message.externalUserId ?? message.userId;
  if (!targetId) throw new Error("Official message target is missing");
  const claim = dependencies.receipts.claim({
    connectionId: source.connectionId,
    chatType: message.chatType,
    targetId,
    messageId: source.messageId,
    activated: !event.contextOnly
  });
  if (claim === "duplicate") return;
  if (claim === "upgrade") message.activationUpgrade = true;

  await dependencies.handleIncomingMessage(message, {
    kind: "qq_official",
    ...(event.contextOnly ? {} : { replyContext: event.permit })
  });
}

import { resolveDispatchableDirectCommand, type ParsedDirectCommand } from "./directCommands.ts";
import type { Relationship } from "#identity/relationship.ts";

export type SetupStateValue = "needs_owner" | "needs_persona" | "ready";

export type PreRouterSetupDecision =
  | { kind: "allow" }
  | {
      kind: "handle_bootstrap_command";
      command: ParsedDirectCommand;
      sessionId: string;
      incomingMessage: {
        chatType: "private";
        userId: string;
      };
    }
  | {
      kind: "reject_private_before_owner_bound";
      userId: string;
      text: string;
    };

export function resolvePreRouterSetupDecision(input: {
  setupState: SetupStateValue;
  eventMessageType: "private" | "group";
  eventUserId: string;
  selfId: string;
  rawText: string;
  segmentCount: number;
}): PreRouterSetupDecision {
  const bootstrapCommand = resolveDispatchableDirectCommand({
    phase: "owner_bootstrap",
    setupState: input.setupState,
    chatType: "private",
    text: input.rawText
  });

  if (bootstrapCommand && input.eventMessageType === "private") {
    return {
      kind: "handle_bootstrap_command",
      command: bootstrapCommand,
      sessionId: `private:${input.eventUserId}`,
      incomingMessage: {
        chatType: "private",
        userId: input.eventUserId
      }
    };
  }

  if (
    input.setupState === "needs_owner"
    && input.eventMessageType === "private"
    && input.eventUserId !== input.selfId
    && (Boolean(input.rawText) || input.segmentCount > 0)
  ) {
    return {
      kind: "reject_private_before_owner_bound",
      userId: input.eventUserId,
      text: "当前实例还没有绑定 owner。请私聊发送 `.own` 绑定自己，或发送 `.own <userId>` 指定一个已经是 bot 好友的用户 ID。"
    };
  }

  return { kind: "allow" };
}

export type PostRouterSetupDecision =
  | { kind: "allow" }
  | { kind: "ignore_during_setup" }
  | {
      kind: "block_private_non_owner";
      text: string;
    };

export function resolvePostRouterSetupDecision(input: {
  setupState: SetupStateValue;
  chatType: "private" | "group";
  relationship: Relationship;
  ownerId?: string;
}): PostRouterSetupDecision {
  if (input.setupState === "ready") {
    return { kind: "allow" };
  }

  if (input.chatType !== "private") {
    return { kind: "ignore_during_setup" };
  }

  if (input.relationship !== "owner") {
    return {
      kind: "block_private_non_owner",
      text: input.ownerId
        ? "当前实例仍在初始化，暂时只接受 owner 私聊补全角色设定。"
        : "当前实例还没有绑定 owner。请先发送 `.own` 完成 owner 认领。"
    };
  }

  return { kind: "allow" };
}

import { resolveDispatchableDirectCommand, type ResolvedDirectCommand } from "./directCommands.ts";
import type { Relationship } from "#identity/relationship.ts";
import { buildPrivateSessionId } from "#conversation/session/sessionIdentity.ts";

export type SetupStateValue = "needs_owner" | "needs_persona" | "ready";

export type PreRouterSetupDecision =
  | { kind: "allow" }
  | {
      kind: "handle_bootstrap_command";
      command: ResolvedDirectCommand;
      sessionId: string;
      incomingMessage: {
        channelId: string;
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
  channelId: string;
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
      sessionId: buildPrivateSessionId(input.channelId, input.eventUserId),
      incomingMessage: {
        channelId: input.channelId,
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
      text: "当前实例还没有完成 OneBot 管理者绑定。请私聊发送 `.own` 绑定自己，或发送 `.own <userId>` 指定一个已与 bot 建立好友关系的用户 ID。"
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
  ownerBound: boolean;
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
      text: input.ownerBound
        ? "当前实例仍在 OneBot 初始化阶段，暂时只接受管理者私聊补全角色设定。"
        : "当前实例还没有完成管理者绑定。请先发送 `.own` 完成认领。"
    };
  }

  return { kind: "allow" };
}

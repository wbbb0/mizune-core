import type { AppConfig } from "#config/config.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";

export type AdmissionThreadAction =
  | "ambient_only"
  | "join_active_thread"
  | "wait_more"
  | "reply_now"
  | "soft_interrupt"
  | "queue_next_thread"
  | "drop_due_cooldown";

export type AdmissionReplyDecision = "no_reply" | "reply_small" | "reply_large" | "wait";
export type AdmissionInterruptPolicy = "none" | "soft_interrupt" | "abort_generation" | "queue";
export type AdmissionContextPolicy = "ambient_buffer" | "merge_batch" | "new_thread" | "ignore";
export type AdmissionPriority = "low" | "normal" | "high" | "owner";

export interface AdmissionDecision {
  groupMatched: boolean;
  matchedPendingGroupTrigger: boolean;
  shouldTriggerResponse: boolean;
  threadAction: AdmissionThreadAction;
  replyDecision: AdmissionReplyDecision;
  interruptPolicy: AdmissionInterruptPolicy;
  contextPolicy: AdmissionContextPolicy;
  priority: AdmissionPriority;
  reason: string;
}

const WAIT_MORE_PATTERNS = [
  /(?:等下|等等|稍等|等我|我贴|我发|我接着|继续发|后面还有|完整日志|先别回|还没说完)/u
] as const;

const CORRECTION_PATTERNS = [
  /(?:不对|不是|改一下|我说错了|重新|应该是|别管.*?了|不用.*?了)/u
] as const;

export function resolveAdmissionDecision(input: {
  config: AppConfig;
  message: ParsedIncomingMessage;
  relationship: Relationship;
  groupMatched: boolean;
  matchedPendingGroupTrigger: boolean;
  replyToBot: boolean;
  hasActiveResponse: boolean;
}): AdmissionDecision {
  if (input.message.chatType !== "group") {
    return privateDecision(input);
  }

  const allowedByAccess = input.relationship === "owner"
    || !input.config.whitelist.enabled
    || input.groupMatched;
  if (!allowedByAccess) {
    return noReply(input, "群聊未授权");
  }

  const text = input.message.text.trim();
  const directlyAddressed = input.message.isAtMentioned || input.replyToBot;
  const sameTriggerUser = input.matchedPendingGroupTrigger;
  const owner = input.relationship === "owner";

  if (input.hasActiveResponse && sameTriggerUser && looksLikeCorrection(text)) {
    return {
      ...base(input),
      shouldTriggerResponse: true,
      threadAction: "soft_interrupt",
      replyDecision: "reply_small",
      interruptPolicy: "soft_interrupt",
      contextPolicy: "merge_batch",
      priority: owner ? "owner" : "high",
      reason: "触发用户修正"
    };
  }

  if (sameTriggerUser && looksLikeWaitMore(text)) {
    return {
      ...base(input),
      shouldTriggerResponse: false,
      threadAction: "wait_more",
      replyDecision: "wait",
      interruptPolicy: "none",
      contextPolicy: "merge_batch",
      priority: owner ? "owner" : "normal",
      reason: "触发用户未说完"
    };
  }

  if (input.hasActiveResponse && directlyAddressed && !sameTriggerUser && !owner) {
    return {
      ...base(input),
      shouldTriggerResponse: true,
      threadAction: "queue_next_thread",
      replyDecision: "no_reply",
      interruptPolicy: "queue",
      contextPolicy: "new_thread",
      priority: "normal",
      reason: "其他用户新问题排队"
    };
  }

  if (directlyAddressed || sameTriggerUser || ownerAllowsNonMention(input)) {
    return {
      ...base(input),
      shouldTriggerResponse: true,
      threadAction: "reply_now",
      replyDecision: "reply_small",
      interruptPolicy: "none",
      contextPolicy: sameTriggerUser ? "merge_batch" : "new_thread",
      priority: owner ? "owner" : input.replyToBot ? "high" : "normal",
      reason: directlyAddressed ? "明确召唤" : "触发用户追发"
    };
  }

  return noReply(input, "普通群聊环境");
}

function base(input: {
  groupMatched: boolean;
  matchedPendingGroupTrigger: boolean;
}): Pick<AdmissionDecision, "groupMatched" | "matchedPendingGroupTrigger"> {
  return {
    groupMatched: input.groupMatched,
    matchedPendingGroupTrigger: input.matchedPendingGroupTrigger
  };
}

function privateDecision(input: {
  relationship: Relationship;
  hasActiveResponse: boolean;
}): AdmissionDecision {
  return {
    groupMatched: false,
    matchedPendingGroupTrigger: false,
    shouldTriggerResponse: true,
    threadAction: "reply_now",
    replyDecision: "reply_small",
    interruptPolicy: input.hasActiveResponse ? "soft_interrupt" : "none",
    contextPolicy: "new_thread",
    priority: input.relationship === "owner" ? "owner" : "normal",
    reason: "私聊默认回复"
  };
}

function noReply(input: {
  groupMatched: boolean;
  matchedPendingGroupTrigger: boolean;
}, reason: string): AdmissionDecision {
  return {
    ...base(input),
    shouldTriggerResponse: false,
    threadAction: "ambient_only",
    replyDecision: "no_reply",
    interruptPolicy: "none",
    contextPolicy: "ambient_buffer",
    priority: "low",
    reason
  };
}

function looksLikeWaitMore(text: string): boolean {
  return WAIT_MORE_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function ownerAllowsNonMention(input: {
  config: AppConfig;
  relationship: Relationship;
  message: ParsedIncomingMessage;
}): boolean {
  return input.relationship === "owner"
    && input.config.conversation.group.requireAtMention === false
    && Boolean(input.message.text.trim());
}

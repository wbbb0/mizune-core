import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { SessionSource } from "./sessionTypes.ts";

export interface PrivateSessionIdentity {
  id: string;
  kind: "private";
  userId: string;
  source: "onebot";
}

export interface GroupSessionIdentity {
  id: string;
  kind: "group";
  groupId: string;
  source: "onebot";
}

export interface WebSessionIdentity {
  id: string;
  kind: "web";
  value: string;
  source: "web";
}

export interface UnknownSessionIdentity {
  id: string;
  kind: "unknown";
  value: string;
  source: "onebot";
}

export type SessionIdentity =
  | PrivateSessionIdentity
  | GroupSessionIdentity
  | WebSessionIdentity
  | UnknownSessionIdentity;

export type ChatSessionIdentity = PrivateSessionIdentity | GroupSessionIdentity;

export function buildPrivateSessionId(userId: string): string {
  return `private:${userId}`;
}

export function buildGroupSessionId(groupId: string): string {
  return `group:${groupId}`;
}

export function buildSessionId(message: Pick<ParsedIncomingMessage, "chatType" | "userId" | "groupId">): string {
  return message.chatType === "group"
    ? buildGroupSessionId(message.groupId ?? "unknown")
    : buildPrivateSessionId(message.userId);
}

// Keep session-id parsing here so prefix rules stay consistent across runtime, tools, and admin flows.
export function parseSessionIdentity(sessionId: string): SessionIdentity {
  if (sessionId.startsWith("private:")) {
    return {
      id: sessionId,
      kind: "private",
      userId: sessionId.slice("private:".length),
      source: "onebot"
    };
  }

  if (sessionId.startsWith("group:")) {
    return {
      id: sessionId,
      kind: "group",
      groupId: sessionId.slice("group:".length),
      source: "onebot"
    };
  }

  if (sessionId.startsWith("web:")) {
    return {
      id: sessionId,
      kind: "web",
      value: sessionId.slice("web:".length),
      source: "web"
    };
  }

  return {
    id: sessionId,
    kind: "unknown",
    value: sessionId,
    source: "onebot"
  };
}

export function parseChatSessionIdentity(sessionId: string): ChatSessionIdentity | null {
  const parsed = parseSessionIdentity(sessionId);
  return parsed.kind === "private" || parsed.kind === "group"
    ? parsed
    : null;
}

export function getSessionChatType(sessionId: string): "private" | "group" | "unknown" {
  const parsed = parseSessionIdentity(sessionId);
  return parsed.kind === "private" || parsed.kind === "group"
    ? parsed.kind
    : "unknown";
}

export function getSessionSource(sessionId: string): SessionSource {
  return parseSessionIdentity(sessionId).source;
}

export function deriveParticipantUserId(sessionId: string, type: "private" | "group"): string {
  const parsed = parseSessionIdentity(sessionId);
  if (type === "private" && parsed.kind === "private") {
    return parsed.userId;
  }
  if (type === "group" && parsed.kind === "group") {
    return parsed.groupId;
  }
  if (parsed.kind === "web") {
    return parsed.value;
  }
  return sessionId;
}

import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { SessionSource } from "./sessionTypes.ts";

export interface PrivateSessionIdentity {
  id: string;
  kind: "private";
  channelId: string;
  userId: string;
  source: "onebot";
}

export interface GroupSessionIdentity {
  id: string;
  kind: "group";
  channelId: string;
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
  source: SessionSource;
}

export type SessionIdentity =
  | PrivateSessionIdentity
  | GroupSessionIdentity
  | WebSessionIdentity
  | UnknownSessionIdentity;

export type ChatSessionIdentity = PrivateSessionIdentity | GroupSessionIdentity;

export interface SessionDisplayInfo {
  participantLabel: string;
  sourceLabel: "OneBot" | "Web";
  kindLabel: "私聊" | "群聊" | "Web" | "未知";
  sessionLabel: string;
}

const sessionIdPattern = /^(?<channelId>[^:]+):(?<kind>p|g):(?<targetId>.+)$/;

export function buildPrivateSessionId(channelId: string, userId: string): string {
  return `${channelId}:p:${userId}`;
}

export function buildGroupSessionId(channelId: string, groupId: string): string {
  return `${channelId}:g:${groupId}`;
}

export function buildSessionId(
  message: Pick<ParsedIncomingMessage, "chatType" | "userId" | "groupId" | "channelId" | "externalUserId">
): string {
  const channelId = String(message.channelId ?? "qqbot").trim() || "qqbot";
  const externalUserId = String(message.externalUserId ?? message.userId).trim() || message.userId;
  return message.chatType === "group"
    ? buildGroupSessionId(channelId, message.groupId ?? "unknown")
    : buildPrivateSessionId(channelId, externalUserId);
}

// Keep session-id parsing here so prefix rules stay consistent across runtime, tools, and admin flows.
export function parseSessionIdentity(sessionId: string): SessionIdentity {
  const matched = sessionId.match(sessionIdPattern);
  if (matched?.groups) {
    const channelId = matched.groups.channelId ?? "qqbot";
    const kind = matched.groups.kind === "p" ? "private" : "group";
    const targetId = matched.groups.targetId ?? "unknown";
    if (kind === "private") {
      return {
        id: sessionId,
        kind,
        channelId,
        userId: targetId,
        source: "onebot"
      };
    }
    return {
      id: sessionId,
      kind,
      channelId,
      groupId: targetId,
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
    source: sessionId.startsWith("web:") ? "web" : "onebot"
  };
}

export function parseChatSessionIdentity(sessionId: string): ChatSessionIdentity | null {
  const parsed = parseSessionIdentity(sessionId);
  return parsed.kind === "private" || parsed.kind === "group"
    ? parsed
    : null;
}

export function isChatSessionIdentity(sessionId: string): boolean {
  return parseChatSessionIdentity(sessionId) != null;
}

export function isWebSessionIdentity(sessionId: string): boolean {
  return parseSessionIdentity(sessionId).kind === "web";
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

export function getSessionSourceLabel(sessionId: string): "OneBot" | "Web" {
  return getSessionSource(sessionId) === "web"
    ? "Web"
    : "OneBot";
}

export function resolveSessionParticipantLabel(input: {
  sessionId: string;
  participantLabel?: string | null | undefined;
  participantUserId?: string | null | undefined;
  type?: "private" | "group" | undefined;
}): string {
  const normalizedParticipantLabel = String(input.participantLabel ?? "").trim();
  if (normalizedParticipantLabel) {
    return normalizedParticipantLabel;
  }

  const normalizedParticipantUserId = String(input.participantUserId ?? "").trim();
  if (normalizedParticipantUserId) {
    return normalizedParticipantUserId;
  }

  const parsed = parseSessionIdentity(input.sessionId);
  if (parsed.kind === "private") {
    return parsed.userId;
  }
  if (parsed.kind === "group") {
    return parsed.groupId;
  }
  if (parsed.kind === "web") {
    return parsed.value;
  }

  if (input.type) {
    return deriveParticipantUserId(input.sessionId, input.type);
  }
  return input.sessionId;
}

export function getSessionDisplayInfo(input: {
  sessionId: string;
  participantLabel?: string | null | undefined;
  participantUserId?: string | null | undefined;
  type?: "private" | "group" | undefined;
}): SessionDisplayInfo {
  const parsed = parseSessionIdentity(input.sessionId);
  const participantLabel = resolveSessionParticipantLabel(input);
  const kindLabel = parsed.kind === "private"
    ? "私聊"
    : parsed.kind === "group"
      ? "群聊"
      : parsed.kind === "web"
        ? "Web"
        : "未知";
  return {
    participantLabel,
    sourceLabel: getSessionSourceLabel(input.sessionId),
    kindLabel,
    sessionLabel: parsed.kind === "unknown"
      ? participantLabel
      : `${kindLabel} ${participantLabel}`
  };
}

export function formatSessionDisplayLabel(input: {
  sessionId: string;
  participantLabel?: string | null | undefined;
  participantUserId?: string | null | undefined;
  type?: "private" | "group" | undefined;
}): string {
  return getSessionDisplayInfo(input).sessionLabel;
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

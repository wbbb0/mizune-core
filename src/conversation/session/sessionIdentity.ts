import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { SessionParticipantRef, SessionSource } from "./sessionTypes.ts";
import { resolveSessionDisplayTitle } from "./sessionTitle.ts";

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
  displayTitle: string;
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
  const normalizedSessionId = String(sessionId ?? "");
  const matched = normalizedSessionId.match(sessionIdPattern);
  if (matched?.groups) {
    const channelId = matched.groups.channelId ?? "qqbot";
    const kind = matched.groups.kind === "p" ? "private" : "group";
    const targetId = matched.groups.targetId ?? "unknown";
    if (kind === "private") {
      return {
        id: normalizedSessionId,
        kind,
        channelId,
        userId: targetId,
        source: "onebot"
      };
    }
    return {
      id: normalizedSessionId,
      kind,
      channelId,
      groupId: targetId,
      source: "onebot"
    };
  }

  if (normalizedSessionId.startsWith("web:")) {
    return {
      id: normalizedSessionId,
      kind: "web",
      value: normalizedSessionId.slice("web:".length),
      source: "web"
    };
  }

  return {
    id: normalizedSessionId,
    kind: "unknown",
    value: normalizedSessionId,
    source: normalizedSessionId.startsWith("web:") ? "web" : "onebot"
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
  participantRef: SessionParticipantRef;
  title?: string | null | undefined;
  type?: "private" | "group" | undefined;
}): string {
  const parsed = parseSessionIdentity(input.sessionId);
  const normalizedTitle = String(input.title ?? "").trim();
  if (parsed.kind === "web" && normalizedTitle) {
    return normalizedTitle;
  }

  return input.participantRef.id;
}

export function resolveSessionParticipantRef(input: {
  sessionId: string;
  type: "private" | "group";
  participantRef?: SessionParticipantRef | null | undefined;
}): SessionParticipantRef {
  const normalizedSessionId = String(input.sessionId ?? "");
  if (input.participantRef) {
    return {
      kind: input.participantRef.kind,
      id: String(input.participantRef.id ?? "").trim() || deriveParticipantUserId(normalizedSessionId, input.type)
    };
  }

  const parsed = parseSessionIdentity(normalizedSessionId);
  if (parsed.kind === "private") {
    return {
      kind: "user",
      id: parsed.userId
    };
  }
  if (parsed.kind === "group") {
    return {
      kind: "group",
      id: parsed.groupId
    };
  }
  if (parsed.kind === "web") {
    return {
      kind: input.type === "group" ? "group" : "user",
      id: parsed.value
    };
  }

  return {
    kind: input.type === "group" ? "group" : "user",
    id: normalizedSessionId || deriveParticipantUserId(normalizedSessionId, input.type)
  };
}

export function getSessionParticipantUserId(input: {
  participantRef: SessionParticipantRef;
}): string {
  return input.participantRef.id;
}

export function getSessionParticipantLabel(input: {
  participantRef: SessionParticipantRef;
  title?: string | null | undefined;
  sessionId: string;
}): string {
  return resolveSessionParticipantLabel({
    sessionId: input.sessionId,
    participantRef: input.participantRef,
    title: input.title
  });
}

export function getSessionDisplayInfo(input: {
  sessionId: string;
  title?: string | null | undefined;
  type?: "private" | "group" | undefined;
  participantRef?: SessionParticipantRef | null | undefined;
}): SessionDisplayInfo {
  const parsed = parseSessionIdentity(input.sessionId);
  const participantRef = input.participantRef ?? resolveSessionParticipantRef({
    sessionId: input.sessionId,
    type: parsed.kind === "group"
      ? "group"
      : "private"
  });
  const participantLabel = resolveSessionParticipantLabel({
    sessionId: input.sessionId,
    participantRef,
    title: input.title
  });
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
    displayTitle: resolveSessionDisplayTitle({
      id: input.sessionId,
      source: getSessionSource(input.sessionId),
      type: parsed.kind === "group"
        ? "group"
        : "private",
      participantRef,
      title: input.title ?? null
    }),
    sessionLabel: parsed.kind === "unknown"
      ? participantLabel
      : `${kindLabel} ${participantLabel}`
  };
}

export function formatSessionDisplayLabel(input: {
  sessionId: string;
  title?: string | null | undefined;
  type?: "private" | "group" | undefined;
  participantRef?: SessionParticipantRef | null | undefined;
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

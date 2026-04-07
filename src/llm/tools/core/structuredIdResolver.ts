import type { BuiltinToolContext } from "./shared.ts";

const FORWARD_REF_REGEX = /⟦ref\b[^⟧]*\bkind="forward"[^⟧]*\bforward_id="([^"]+)"/g;
const REPLY_REF_REGEX = /⟦ref\b[^⟧]*\bkind="reply"[^⟧]*\bmessage_id="([^"]+)"/g;

export function resolveForwardIdArg(
  requestedId: string,
  toolArgumentsRaw: string,
  context: BuiltinToolContext
): string {
  return resolveStructuredIdArg({
    requestedId,
    toolArgumentsRaw,
    key: "forward_id",
    knownIds: collectKnownForwardIds(context)
  });
}

export function resolveMessageIdArg(
  requestedId: string,
  toolArgumentsRaw: string,
  context: BuiltinToolContext
): string {
  return resolveStructuredIdArg({
    requestedId,
    toolArgumentsRaw,
    key: "message_id",
    knownIds: collectKnownMessageIds(context)
  });
}

function resolveStructuredIdArg(input: {
  requestedId: string;
  toolArgumentsRaw: string;
  key: string;
  knownIds: string[];
}): string {
  const requestedId = input.requestedId.trim();
  if (!requestedId) {
    return "";
  }
  if (input.knownIds.includes(requestedId)) {
    return requestedId;
  }

  const rawValue = extractRawJsonValue(input.toolArgumentsRaw, input.key);
  if (!rawValue || rawValue.startsWith("\"") || !/^\d+$/.test(requestedId)) {
    return requestedId;
  }

  return findNearbyKnownId(requestedId, input.knownIds) ?? requestedId;
}

function collectKnownForwardIds(context: BuiltinToolContext): string[] {
  const ids = new Set<string>();
  const sessionId = context.lastMessage?.sessionId;
  if (!sessionId) {
    return [];
  }

  try {
    const session = context.sessionManager.getSession(sessionId);
    for (const message of session.pendingMessages) {
      for (const forwardId of message.forwardIds) {
        ids.add(forwardId);
      }
    }
  } catch {
    // Ignore missing session snapshots during tool execution.
  }

  try {
    const sessionView = context.sessionManager.getSessionView(sessionId);
    for (const message of context.sessionManager.getLlmVisibleHistory(sessionId)) {
      for (const forwardId of extractRefIds(message.content, FORWARD_REF_REGEX)) {
        ids.add(forwardId);
      }
    }
  } catch {
    // Ignore missing session snapshots during tool execution.
  }

  return [...ids];
}

function collectKnownMessageIds(context: BuiltinToolContext): string[] {
  const ids = new Set<string>();
  const sessionId = context.lastMessage?.sessionId;
  if (!sessionId) {
    return [];
  }

  try {
    const session = context.sessionManager.getSession(sessionId);
    for (const message of session.pendingMessages) {
      if (message.replyMessageId) {
        ids.add(message.replyMessageId);
      }
      if (message.rawEvent?.message_id != null) {
        ids.add(String(message.rawEvent.message_id));
      }
    }
  } catch {
    // Ignore missing session snapshots during tool execution.
  }

  try {
    const sessionView = context.sessionManager.getSessionView(sessionId);
    for (const message of context.sessionManager.getLlmVisibleHistory(sessionId)) {
      for (const messageId of extractRefIds(message.content, REPLY_REF_REGEX)) {
        ids.add(messageId);
      }
    }
    for (const sentMessage of sessionView.sentMessages) {
      ids.add(String(sentMessage.messageId));
    }
  } catch {
    // Ignore missing session snapshots during tool execution.
  }

  return [...ids];
}

function extractRefIds(content: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const match of content.matchAll(pattern)) {
    const id = String(match[1] ?? "").trim();
    if (id) {
      matches.push(id);
    }
  }
  return matches;
}

function extractRawJsonValue(raw: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`"${escapedKey}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`);
  const match = raw.match(pattern);
  return match?.[1] ?? null;
}

function findNearbyKnownId(requestedId: string, knownIds: string[]): string | null {
  if (!/^\d{16,}$/.test(requestedId)) {
    return null;
  }

  const minCommonPrefix = Math.max(12, requestedId.length - 4);
  const maxDifference = BigInt(10) ** BigInt(Math.max(1, requestedId.length - minCommonPrefix));
  const matches = knownIds
    .filter((candidate) => /^\d+$/.test(candidate) && candidate.length === requestedId.length)
    .map((candidate) => ({
      id: candidate,
      prefixLength: getCommonPrefixLength(requestedId, candidate),
      difference: absoluteBigIntDifference(requestedId, candidate)
    }))
    .filter((candidate) => candidate.prefixLength >= minCommonPrefix && candidate.difference <= maxDifference)
    .sort((left, right) => {
      if (left.difference < right.difference) {
        return -1;
      }
      if (left.difference > right.difference) {
        return 1;
      }
      return right.prefixLength - left.prefixLength;
    });

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    const [best, next] = matches;
    if (best && next && best.difference === next.difference && best.prefixLength === next.prefixLength) {
      return null;
    }
  }

  return matches[0]?.id ?? null;
}

function getCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function absoluteBigIntDifference(left: string, right: string): bigint {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue >= rightValue ? leftValue - rightValue : rightValue - leftValue;
}

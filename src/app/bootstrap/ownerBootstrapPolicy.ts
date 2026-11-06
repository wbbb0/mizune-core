import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
export interface OwnerBootstrapCommand {
  userId?: string;
}

const OWNER_BOOTSTRAP_COMMAND_PATTERN = /^[。.]\s*own(?:\s+(\S+))?\s*$/i;

// Bootstrap-time owner binding is infrastructure policy, not general chat-command routing.
export function parseOwnerBootstrapCommand(text: string): OwnerBootstrapCommand | null {
  const match = text.trim().match(OWNER_BOOTSTRAP_COMMAND_PATTERN);
  if (!match) {
    return null;
  }
  return match[1] ? { userId: match[1] } : {};
}

export function isOwnerBootstrapCommandText(text: string): boolean {
  return parseOwnerBootstrapCommand(text) != null;
}

export function isTextOnlyBootstrapMessage(message: ParsedIncomingMessage): boolean {
  return message.images.length === 0 && message.imageIds.length === 0 && message.audioSources.length === 0 && message.audioIds.length === 0 && message.forwardIds.length === 0
    && message.emojiSources.length === 0 && message.emojiIds.length === 0 && !message.attachments?.length && !message.remoteAttachments?.length
    && (!message.contentParts || message.contentParts.every(part => part.kind === "text"));
}

export interface OwnerBootstrapCommand {
  userId?: string;
}

const OWNER_BOOTSTRAP_COMMAND_PATTERN = /^[。.]\s*own(?:\s+(\d+))?\s*$/i;

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

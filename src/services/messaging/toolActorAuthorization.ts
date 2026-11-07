/** Provenance captured by the authenticated ingress, never from tool arguments. */
export type ToolActorAuthorization =
  | { kind: "external"; channelId: string; externalId: string; scope: "private_user" | "group_member"; internalUserId: string }
  | { kind: "web"; internalUserId: string };

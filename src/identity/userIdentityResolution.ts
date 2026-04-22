import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { UserStore } from "./userStore.ts";
import type { UserIdentityStore } from "./userIdentityStore.ts";

export async function resolveInternalUserIdForOneBotPrivateUser(input: {
  channelId: string;
  externalUserId: string;
  userIdentityStore: Pick<UserIdentityStore, "findInternalUserId">;
}): Promise<string> {
  return (await input.userIdentityStore.findInternalUserId({
    channelId: input.channelId,
    externalId: input.externalUserId
  })) ?? input.externalUserId;
}

export async function resolveInternalUserIdForSessionPrivateTarget(input: {
  sessionId: string;
  userIdentityStore: Pick<UserIdentityStore, "findInternalUserId">;
}): Promise<string | null> {
  const parsed = parseChatSessionIdentity(input.sessionId);
  if (!parsed || parsed.kind !== "private") {
    return null;
  }
  return resolveInternalUserIdForOneBotPrivateUser({
    channelId: parsed.channelId,
    externalUserId: parsed.userId,
    userIdentityStore: input.userIdentityStore
  });
}

export async function resolveStoredUserForSessionPrivateTarget(input: {
  sessionId: string;
  userIdentityStore: Pick<UserIdentityStore, "findInternalUserId">;
  userStore: Pick<UserStore, "getByUserId">;
}) {
  const internalUserId = await resolveInternalUserIdForSessionPrivateTarget({
    sessionId: input.sessionId,
    userIdentityStore: input.userIdentityStore
  });
  return internalUserId ? input.userStore.getByUserId(internalUserId) : null;
}

export async function resolveExternalUserIdForInternalUser(input: {
  internalUserId: string;
  userIdentityStore: Pick<UserIdentityStore, "findIdentityByInternalUserId">;
}): Promise<string | null> {
  return (await input.userIdentityStore.findIdentityByInternalUserId(input.internalUserId))?.externalId ?? null;
}

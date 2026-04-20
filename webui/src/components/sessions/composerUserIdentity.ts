export interface ComposerIdentitySession {
  type: "private" | "group";
  source: "onebot" | "web";
  participantUserId: string;
}

export function resolveComposerUserIdentity(input: {
  session: ComposerIdentitySession | null | undefined;
  ownerId?: string | null;
}): {
  lockedUserId: string | undefined;
  defaultUserId: string | undefined;
} {
  if (!input.session) {
    return {
      lockedUserId: undefined,
      defaultUserId: undefined
    };
  }

  if (input.session.type === "private") {
    return {
      lockedUserId: input.session.participantUserId,
      defaultUserId: undefined
    };
  }

  return {
    lockedUserId: undefined,
    defaultUserId: input.ownerId ?? undefined
  };
}

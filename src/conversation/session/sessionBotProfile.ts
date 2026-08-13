import { z } from "zod";

export const SESSION_BOT_PROFILE_MAX_FIELD_LENGTH = 1_000;
export const SESSION_BOT_PROFILE_MAX_TOTAL_LENGTH = 3_000;

const sessionBotProfileFieldSchema = z.string().trim().max(SESSION_BOT_PROFILE_MAX_FIELD_LENGTH);

export const sessionBotProfileSchema = z.object({
  name: sessionBotProfileFieldSchema.max(80).optional(),
  identity: sessionBotProfileFieldSchema.optional(),
  background: sessionBotProfileFieldSchema.optional(),
  temperament: sessionBotProfileFieldSchema.optional(),
  voiceStyle: sessionBotProfileFieldSchema.optional()
}).strict().superRefine((profile, context) => {
  const totalLength = Object.values(profile).reduce((total, value) => total + (value?.trim().length ?? 0), 0);
  if (totalLength > SESSION_BOT_PROFILE_MAX_TOTAL_LENGTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `当前聊天身份总长度不能超过 ${SESSION_BOT_PROFILE_MAX_TOTAL_LENGTH} 个字符`
    });
  }
});

export type SessionBotProfile = z.infer<typeof sessionBotProfileSchema>;
export type SessionBotProfileField = keyof SessionBotProfile;

export const sessionBotProfileFields = [
  "name",
  "identity",
  "background",
  "temperament",
  "voiceStyle"
] as const satisfies readonly SessionBotProfileField[];

export function normalizeSessionBotProfile(input: unknown): SessionBotProfile | null {
  if (input == null) {
    return null;
  }
  const parsed = sessionBotProfileSchema.parse(input);
  const profile = Object.fromEntries(
    sessionBotProfileFields.flatMap((field) => {
      const value = parsed[field]?.trim();
      return value ? [[field, value]] : [];
    })
  ) as SessionBotProfile;
  return Object.keys(profile).length > 0 ? profile : null;
}

export function cloneSessionBotProfile(profile: SessionBotProfile | null): SessionBotProfile | null {
  return profile == null ? null : { ...profile };
}

export function patchSessionBotProfile(
  current: SessionBotProfile | null,
  patch: SessionBotProfile
): SessionBotProfile | null {
  return normalizeSessionBotProfile({
    ...(current ?? {}),
    ...patch
  });
}

export function clearSessionBotProfileFields(
  current: SessionBotProfile | null,
  fields?: readonly SessionBotProfileField[]
): SessionBotProfile | null {
  if (!current || fields == null) {
    return null;
  }
  const next = { ...current };
  for (const field of fields) {
    delete next[field];
  }
  return normalizeSessionBotProfile(next);
}

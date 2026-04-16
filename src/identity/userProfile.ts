export const USER_PROFILE_SUMMARY_MAX_LENGTH = 120;

type UserProfileField =
  | "preferredAddress"
  | "gender"
  | "residence"
  | "timezone"
  | "occupation"
  | "profileSummary"
  | "relationshipNote";

const USER_PROFILE_FIELD_MAX_LENGTH: Record<UserProfileField, number> = {
  preferredAddress: 40,
  gender: 20,
  residence: 40,
  timezone: 40,
  occupation: 40,
  profileSummary: USER_PROFILE_SUMMARY_MAX_LENGTH,
  relationshipNote: 120
};

function normalizeSingleLineText(value: string): string {
  return value
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function normalizeUserProfileField(
  field: UserProfileField,
  value: string | undefined
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeSingleLineText(String(value));
  if (!normalized) {
    return undefined;
  }

  if (field === "profileSummary") {
    return normalizeProfileSummary(normalized);
  }

  return truncateText(normalized, USER_PROFILE_FIELD_MAX_LENGTH[field]);
}

export function normalizeProfileSummary(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeSingleLineText(value);
  if (!normalized) {
    return undefined;
  }

  const clauses = normalized
    .split(/[；;。！？!?]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 2);
  const compact = clauses.length > 0 ? clauses.join("；") : normalized;
  return truncateText(compact, USER_PROFILE_SUMMARY_MAX_LENGTH);
}

export function normalizeUserProfilePatch(input: {
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  timezone?: string;
  occupation?: string;
  profileSummary?: string;
  relationshipNote?: string;
}): {
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  timezone?: string;
  occupation?: string;
  profileSummary?: string;
  relationshipNote?: string;
} {
  const preferredAddress = normalizeUserProfileField("preferredAddress", input.preferredAddress);
  const gender = normalizeUserProfileField("gender", input.gender);
  const residence = normalizeUserProfileField("residence", input.residence);
  const timezone = normalizeUserProfileField("timezone", input.timezone);
  const occupation = normalizeUserProfileField("occupation", input.occupation);
  const profileSummary = normalizeUserProfileField("profileSummary", input.profileSummary);
  const relationshipNote = normalizeUserProfileField("relationshipNote", input.relationshipNote);

  return {
    ...(preferredAddress ? { preferredAddress } : {}),
    ...(gender ? { gender } : {}),
    ...(residence ? { residence } : {}),
    ...(timezone ? { timezone } : {}),
    ...(occupation ? { occupation } : {}),
    ...(profileSummary ? { profileSummary } : {}),
    ...(relationshipNote ? { relationshipNote } : {})
  };
}

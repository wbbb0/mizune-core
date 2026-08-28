export type LlmCatalogProviderMutation =
  | { kind: "rename_provider"; provider: string; nextProvider: string }
  | { kind: "delete_provider"; provider: string };

export function resolveProviderMutationSource(
  mutations: readonly LlmCatalogProviderMutation[],
  provider: string
): string | null {
  const pending = mutations.find((mutation) => mutation.provider === provider
    || (mutation.kind === "rename_provider" && mutation.nextProvider === provider));
  return pending?.provider ?? null;
}

export function mergeProviderMutation(
  mutations: readonly LlmCatalogProviderMutation[],
  incoming: LlmCatalogProviderMutation
): LlmCatalogProviderMutation[] {
  const next = [...mutations];
  const existingIndex = next.findIndex((mutation) => mutation.provider === incoming.provider
    || (mutation.kind === "rename_provider" && mutation.nextProvider === incoming.provider));
  if (existingIndex < 0) {
    return [...next, incoming];
  }

  const existing = next[existingIndex];
  if (!existing) {
    return [...next, incoming];
  }
  if (incoming.kind === "delete_provider") {
    next[existingIndex] = { kind: "delete_provider", provider: existing.provider };
    return next;
  }

  if (incoming.nextProvider === existing.provider) {
    next.splice(existingIndex, 1);
    return next;
  }
  next[existingIndex] = {
    kind: "rename_provider",
    provider: existing.provider,
    nextProvider: incoming.nextProvider
  };
  return next;
}

export function reconcileProviderMutations(
  mutations: readonly LlmCatalogProviderMutation[],
  draft: unknown,
  baseline: unknown
): LlmCatalogProviderMutation[] {
  const draftProviders = asRecord(draft);
  const baselineProviders = asRecord(baseline);

  return mutations.filter((mutation) => {
    if (mutation.kind === "delete_provider") {
      return !providerWasRestored(mutation.provider, draftProviders, baselineProviders);
    }
    const sourceRestored = providerWasRestored(mutation.provider, draftProviders, baselineProviders)
      && !(mutation.nextProvider in draftProviders);
    return !sourceRestored;
  });
}

function providerWasRestored(
  provider: string,
  draft: Record<string, unknown>,
  baseline: Record<string, unknown>
): boolean {
  return provider in draft
    && provider in baseline
    && deepEqual(draft[provider], baseline[provider]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord === left || rightRecord === right) {
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => key in rightRecord && deepEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

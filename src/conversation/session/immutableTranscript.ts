import type { InternalTranscriptItem } from "./sessionTypes.ts";

const frozenValues = new WeakSet<object>();

/** Transcript entries are immutable values. Replace an entry when its metadata changes. */
export function freezeTranscriptItem<T extends InternalTranscriptItem>(item: T): T {
  freezeJson(item);
  return item;
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object" || frozenValues.has(value)) return;
  frozenValues.add(value);
  Object.freeze(value);
  for (const child of Object.values(value)) freezeJson(child);
}

export function isImmutableTranscriptItem(item: InternalTranscriptItem): boolean {
  return frozenValues.has(item);
}

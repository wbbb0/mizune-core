import type { MessageContentPart } from "#messages/contentParts.ts";

/** Normalize only root platform mention entities, matching OneBot's text/mention separation. */
export function normalizeQqAddressing(parts: readonly MessageContentPart[], mentions: readonly unknown[], selfId?: string) {
  const identities = new Map<string, boolean>();
  if (selfId) identities.set(selfId, true);
  for (const value of mentions.slice(0, 200)) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    for (const key of ["id", "member_openid", "user_openid"]) {
      const id = item[key];
      if (typeof id === "string" && id) identities.set(id, identities.get(id) === true || item.is_you === true || id === selfId);
    }
  }
  const normalized: MessageContentPart[] = [];
  for (const part of parts) {
    if (part.kind !== "text") { normalized.push(part); continue; }
    let offset = 0;
    for (const match of part.text.matchAll(/<@!?([^\s<>]{1,160})>/g)) {
      const id = match[1]!;
      if (id !== "all" && !identities.has(id)) continue;
      if (match.index > offset) normalized.push({ kind: "text", text: part.text.slice(offset, match.index) });
      normalized.push(id === "all" ? { kind: "mention", target: "all" }
        : identities.get(id) ? { kind: "mention", target: "self" } : { kind: "mention", target: "user", userId: id });
      offset = match.index + match[0].length;
    }
    if (offset < part.text.length) normalized.push({ kind: "text", text: part.text.slice(offset) });
  }
  return { parts: normalized, text: normalized.flatMap(part => part.kind === "text" ? [part.text] : []).join("").trim() };
}

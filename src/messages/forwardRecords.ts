import { createHash } from "node:crypto";
import type { MessageContentPart } from "./contentParts.ts";
import { walkMessageContentParts } from "./contentParts.ts";

type EmbeddedRecord = Extract<MessageContentPart, { kind: "embedded_message" }>;

/** Content identity excludes mutable download results; a pending asset and its recovered file share one identity. */
function identity(part: MessageContentPart): unknown {
  switch (part.kind) {
    case "embedded_message": return [part.kind, part.relation, part.messageId, part.senderId, part.senderName, part.parts.map(identity), part.truncated];
    case "pending_media": return ["media", part.mediaKind, part.mediaRef];
    case "image": case "emoji": return ["media", part.kind, part.mediaRef ?? part.fileId ?? part.source];
    case "asset_file": return ["media", part.fileKind === "video" ? "video" : "file", part.mediaRef ?? part.fileId];
    case "text": return [part.kind, part.text];
    case "audio": return [part.kind, part.audioId ?? part.source];
    case "forward": return [part.kind, part.forwardId];
    case "reply": return [part.kind, part.messageId];
    case "mention": return [part.kind, part.target, part.userId];
    case "special": return [part.kind, part.segmentType, part.summary];
    case "file": return [part.kind, part.file.fileId, part.file.name, part.file.busid, part.file.sizeBytes, part.file.mimeType];
    case "remote_file": return [part.kind, part.source, part.sourceName, part.mimeType, part.fileKind];
  }
}

export function cachedForwardRecordRef(part: EmbeddedRecord): string {
  return `record_${createHash("sha256").update(JSON.stringify(identity(part))).digest("hex").slice(0, 32)}`;
}

export function nativeForwardRecordRef(id: string): string {
  return `onebot_${Buffer.from(id).toString("base64url")}`;
}

export function decodeNativeForwardRecordRef(ref: string): string | null {
  if (!/^onebot_[A-Za-z0-9_-]{1,400}$/.test(ref)) return null;
  const id = Buffer.from(ref.slice(7), "base64url").toString("utf8");
  return id && nativeForwardRecordRef(id) === ref ? id : null;
}

export function forwardRecordMessageCount(part: EmbeddedRecord): number {
  return part.recordMessageCount ?? Math.max(1, [...walkMessageContentParts(part.parts)].filter(child => child.kind === "embedded_message" && child.relation === "message").length);
}

/** This is a model projection, never a mutation of the received tree or a second content store. */
export function foldForwardRecords(parts: readonly MessageContentPart[], options: { nativeReferences?: boolean } = {}): MessageContentPart[] {
  return parts.map(part => {
    if (part.kind === "forward") return { ...part, recordRef: nativeForwardRecordRef(part.forwardId) };
    if (part.kind !== "embedded_message") return part;
    if (part.relation !== "forward") return { ...part, parts: foldForwardRecords(part.parts, options) };
    if (options.nativeReferences && part.messageId) {
      return { kind: "forward", forwardId: part.messageId, recordRef: nativeForwardRecordRef(part.messageId) };
    }
    return { ...part, recordRef: part.recordRef ?? cachedForwardRecordRef(part),
      recordMessageCount: forwardRecordMessageCount(part), parts: [] };
  });
}

/** Pages consist of bounded text/media segments; nested forwards remain separate readable records. */
export function forwardRecordSegments(parts: readonly MessageContentPart[]): MessageContentPart[] {
  const output: MessageContentPart[] = [];
  const visit = (input: readonly MessageContentPart[], parents: EmbeddedRecord[]) => {
    for (const part of input) {
      if (part.kind === "embedded_message" && part.relation !== "forward") { visit(part.parts, [...parents, part]); continue; }
      const text = part.kind === "text" ? part.text : part.kind === "special" ? part.summary : null;
      const leaves = text != null ? Array.from({ length: Math.ceil(text.length / 1000) }, (_, index): MessageContentPart =>
        part.kind === "special" ? { ...part, summary: text.slice(index * 1000, (index + 1) * 1000) }
          : { kind: "text", text: text.slice(index * 1000, (index + 1) * 1000) }) : foldForwardRecords([part]);
      for (const leaf of leaves) output.push(parents.reduceRight<MessageContentPart>((child, parent) => ({ ...parent, parts: [child] }), leaf));
    }
  };
  visit(parts, []);
  return output;
}

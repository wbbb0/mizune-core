import type { MessageContentPart } from "#messages/contentParts.ts";
import type { ParsedIncomingMessage } from "../messaging/incomingMessage.ts";

export const QQ_EMBEDDED_LIMITS = Object.freeze({ depth: 6, nodes: 200, textCharacters: 24_000, media: 16 });
const MAX_METADATA_CHARACTERS = 160;
const MAX_URL_CHARACTERS = 8192;
const MAX_ARRAY_ENTRIES = 200;

type JsonRecord = Record<string, unknown>;
type EmbeddedPart = Extract<MessageContentPart, { kind: "embedded_message" }>;
interface Budget {
  nodes: number;
  text: number;
  media: number;
  ancestors: WeakSet<object>;
}
interface ContentResult { parts: MessageContentPart[]; truncated: boolean; }

export interface QqDecodedMessageContent {
  text: string;
  parts: MessageContentPart[];
  images: string[];
  audioSources: string[];
  remoteAttachments: NonNullable<ParsedIncomingMessage["remoteAttachments"]>;
  specialSegments: Array<{ type: string; summary: string }>;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function metadata(value: unknown): string { return string(value).slice(0, MAX_METADATA_CHARACTERS); }
function relation(value: unknown): EmbeddedPart["relation"] {
  return value === 103 ? "reply" : value === 102 ? "forward" : "message";
}
function takeText(value: string, budget: Budget): { text: string; truncated: boolean } {
  const text = value.slice(0, budget.text);
  budget.text -= text.length;
  return { text, truncated: text.length < value.length };
}
function mediaUrl(value: unknown): string | null {
  const input = string(value);
  if (!input || input.length > MAX_URL_CHARACTERS) return null;
  try {
    const url = new URL(input);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Only message content is projected. Event credentials and unknown card fields never enter the tree. */
function decodeOwnContent(node: JsonRecord, budget: Budget): ContentResult {
  const parts: MessageContentPart[] = [];
  let truncated = false;
  const body = takeText(string(node.content), budget);
  if (body.text) parts.push({ kind: "text", text: body.text });
  truncated ||= body.truncated;

  const attachments = Array.isArray(node.attachments) ? node.attachments : [];
  if (attachments.length > MAX_ARRAY_ENTRIES) truncated = true;
  for (const raw of attachments.slice(0, MAX_ARRAY_ENTRIES)) {
    const attachment = record(raw);
    if (!attachment) continue;
    const source = mediaUrl(attachment.url);
    if (!source) continue;
    if (budget.media === 0) { truncated = true; break; }
    budget.media -= 1;
    const mimeType = metadata(attachment.content_type);
    const sourceName = metadata(attachment.filename) || "附件";
    if (mimeType.startsWith("image/")) {
      parts.push({ kind: "image", source, sourceName, mimeType });
    } else if (mimeType === "voice" || mimeType.startsWith("audio/")) {
      parts.push({ kind: "audio", source: mediaUrl(attachment.voice_wav_url) ?? source });
    } else {
      parts.push({ kind: "remote_file", source, sourceName, mimeType, fileKind: mimeType.startsWith("video/") ? "video" : "file" });
    }
  }

  const card = record(node.ark_data);
  if (card) {
    const fields = record(card.fields) ?? {};
    const values: string[] = [];
    const title = metadata(card.ark_name) || metadata(card.ark_type);
    if (title) values.push(title);
    // Do not retain the raw object, URLs, arbitrary extension fields, or event auth tokens.
    for (const key of ["title", "desc", "source", "tag", "nickname", "address"] as const) {
      const value = string(fields[key]).slice(0, 1000);
      if (value) values.push(`${key}: ${value}`);
    }
    const summary = takeText(values.join("\n"), budget);
    if (summary.text) parts.push({ kind: "special", segmentType: "qq_card", summary: summary.text });
    truncated ||= summary.truncated;
  }
  return { parts, truncated };
}

function decodeElement(raw: unknown, depth: number, budget: Budget): EmbeddedPart | null {
  const node = record(raw);
  if (!node) return null;
  if (depth > QQ_EMBEDDED_LIMITS.depth || budget.nodes === 0) {
    return { kind: "embedded_message", relation: relation(node.message_type), parts: [], truncated: true };
  }
  budget.nodes -= 1;
  if (budget.ancestors.has(node)) return { kind: "embedded_message", relation: relation(node.message_type), parts: [], truncated: true };
  budget.ancestors.add(node);
  try {
    const own = decodeOwnContent(node, budget);
    const child = decodeElements(node.msg_elements, depth + 1, budget);
    const author = record(node.author) ?? {};
    const senderId = metadata(author.member_openid) || metadata(author.user_openid) || metadata(author.id);
    const senderName = metadata(author.username);
    const messageId = metadata(node.msg_idx);
    return {
      kind: "embedded_message", relation: relation(node.message_type),
      ...(messageId ? { messageId } : {}), ...(senderId ? { senderId } : {}), ...(senderName ? { senderName } : {}),
      parts: [...own.parts, ...child.parts],
      ...(own.truncated || child.truncated ? { truncated: true } : {})
    };
  } finally { budget.ancestors.delete(node); }
}

function decodeElements(value: unknown, depth: number, budget: Budget): ContentResult {
  const elements = Array.isArray(value) ? value : [];
  const parts: MessageContentPart[] = [];
  let truncated = elements.length > MAX_ARRAY_ENTRIES;
  for (const element of elements.slice(0, MAX_ARRAY_ENTRIES)) {
    if (budget.nodes === 0 || depth > QQ_EMBEDDED_LIMITS.depth) { truncated = true; break; }
    const decoded = decodeElement(element, depth, budget);
    if (decoded) {
      parts.push(decoded);
      truncated ||= decoded.truncated === true;
    }
  }
  return { parts, truncated };
}

export function decodeQqMessageContent(event: JsonRecord, replyMessageId?: string): QqDecodedMessageContent {
  const budget: Budget = {
    nodes: QQ_EMBEDDED_LIMITS.nodes, text: QQ_EMBEDDED_LIMITS.textCharacters,
    media: QQ_EMBEDDED_LIMITS.media, ancestors: new WeakSet([event])
  };
  // The sender's actual request remains first; referenced authors never become the current actor.
  const root = decodeOwnContent(event, budget);
  const embedded = decodeElements(event.msg_elements, 1, budget);
  const parts = [...root.parts];
  if (embedded.parts.length > 0 || embedded.truncated) {
    parts.push({
      kind: "embedded_message", relation: replyMessageId ? "reply" : relation(event.message_type),
      ...(replyMessageId ? { messageId: replyMessageId.slice(0, MAX_METADATA_CHARACTERS) } : {}),
      parts: embedded.parts, ...(embedded.truncated ? { truncated: true } : {})
    });
  } else if (replyMessageId) {
    parts.push({ kind: "reply", messageId: replyMessageId.slice(0, MAX_METADATA_CHARACTERS) });
  }
  if (root.truncated) parts.push({ kind: "special", segmentType: "qq_message_truncated", summary: "消息内容超过接收上限，部分内容未展开。" });
  return {
    text: root.parts.flatMap(part => part.kind === "text" ? [part.text] : []).join(""), parts,
    images: root.parts.flatMap(part => part.kind === "image" && part.source ? [part.source] : []),
    audioSources: root.parts.flatMap(part => part.kind === "audio" && part.source ? [part.source] : []),
    remoteAttachments: root.parts.flatMap(part => part.kind === "remote_file" ? [{ source: part.source, sourceName: part.sourceName, mimeType: part.mimeType, kind: part.fileKind }] : []),
    specialSegments: root.parts.flatMap(part => part.kind === "special" ? [{ type: part.segmentType, summary: part.summary }] : [])
  };
}

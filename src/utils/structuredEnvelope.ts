export const PROTOCOL_PREFIX = "%%llmbot:";

export const PROTOCOL_TAGS = [
  "asset_file",
  "audio",
  "count",
  "draft_batch",
  "draft_message",
  "envelope",
  "event",
  "file",
  "history_message",
  "message",
  "mention",
  "placeholder",
  "planner_batch_message",
  "planner_history_message",
  "profile_phase_transition",
  "ref",
  "scheduled_history_message",
  "section",
  "segment",
  "session_mode_switch",
  "summary_source_message",
  "summary_source_tool_observation",
  "trigger_batch",
  "trigger_message",
  "speaker"
] as const;

export type ProtocolTagName = (typeof PROTOCOL_TAGS)[number];

const PROTOCOL_TAG_SET = new Set<string>(PROTOCOL_TAGS);
const PROTOCOL_TAG_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const PROTOCOL_ATTR_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const PROTOCOL_LINE_REGEX = /^%%llmbot:(\/?)([a-z][a-z0-9_]*)(?:\s+([^\r\n]*))?$/;
const PROTOCOL_ATTR_REGEX = /([a-z][a-z0-9_]*)="([^"]*)"/g;

export interface ParsedProtocolLine {
  tag: ProtocolTagName;
  closing: boolean;
  attrs: Record<string, string>;
}

function assertProtocolTag(name: string): asserts name is ProtocolTagName {
  if (!PROTOCOL_TAG_NAME_REGEX.test(name) || !PROTOCOL_TAG_SET.has(name)) {
    throw new Error(`Unknown structured protocol tag: ${name}`);
  }
}

export function buildTag(name: string, attrs?: Record<string, string>): string {
  return buildProtocolLine(name, attrs);
}

export function buildOpenTag(name: string, attrs?: Record<string, string>): string {
  return buildProtocolLine(name, attrs);
}

export function buildCloseTag(name: string): string {
  assertProtocolTag(name);
  return `${PROTOCOL_PREFIX}/${name}`;
}

function buildProtocolLine(name: string, attrs?: Record<string, string>): string {
  assertProtocolTag(name);
  const rendered = attrs
    ? Object.entries(attrs)
        .map(([key, value]) => `${formatProtocolAttrName(key)}="${escapeAttr(value)}"`)
        .join(" ")
    : "";
  return rendered ? `${PROTOCOL_PREFIX}${name} ${rendered}` : `${PROTOCOL_PREFIX}${name}`;
}

function formatProtocolAttrName(name: string): string {
  if (!PROTOCOL_ATTR_NAME_REGEX.test(name)) {
    throw new Error(`Invalid structured protocol attribute: ${name}`);
  }
  return name;
}

export function escapeText(value: string): string {
  return String(value).replace(/&/g, "&amp;");
}

export function escapeUserText(value: string): string {
  return escapeText(value).replace(/^%%llmbot:/gm, "\\%%llmbot:");
}

export function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\s+/g, " ")
    .trim();
}

export function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}

export function parseProtocolLine(line: string): ParsedProtocolLine | null {
  const match = PROTOCOL_LINE_REGEX.exec(line);
  if (!match) {
    return null;
  }
  const tag = match[2]!;
  if (!PROTOCOL_TAG_SET.has(tag)) {
    return null;
  }
  const attrsSource = match[3] ?? "";
  const attrs: Record<string, string> = {};
  let consumed = "";
  for (const attrMatch of attrsSource.matchAll(PROTOCOL_ATTR_REGEX)) {
    attrs[attrMatch[1]!] = unescapeAttr(attrMatch[2]!);
    consumed += `${consumed ? " " : ""}${attrMatch[0]}`;
  }
  if (attrsSource.trim() !== consumed) {
    return null;
  }
  return {
    tag: tag as ProtocolTagName,
    closing: match[1] === "/",
    attrs
  };
}

export function isProtocolLine(line: string): boolean {
  return parseProtocolLine(line.replace(/\r$/, "")) !== null;
}

export function startsWithTag(line: string): boolean {
  return isProtocolLine(line);
}

export function stripProtocolLines(text: string): string {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  return lines.filter((line) => !isProtocolLine(line)).join("\n");
}

export type StructuredEnvelopeValue = string | number | boolean | null | undefined;

export interface StructuredEnvelopeField {
  label: string;
  value: StructuredEnvelopeValue;
}

const WHITESPACE_REGEX = /\s+/g;

export function formatStructuredEnvelope(input: {
  title: string;
  fields: readonly StructuredEnvelopeField[];
}): string {
  const title = sanitizeRequiredEnvelopeText(input.title, "title");
  const lines = [
    ...input.fields
      .filter((field) => hasVisibleEnvelopeValue(field.value))
      .map((field) => {
        const label = sanitizeRequiredEnvelopeText(field.label, "field label");
        return `${label}: ${sanitizeEnvelopeText(String(field.value))}`;
      })
  ];
  if (lines.length === 0) {
    return "";
  }
  return `${buildOpenTag("envelope", { title })}\n${lines.join("\n")}\n${buildCloseTag("envelope")}`;
}

export function sanitizeEnvelopeText(value: string): string {
  return escapeUserText(value.replace(WHITESPACE_REGEX, " ").trim());
}

function sanitizeRequiredEnvelopeText(value: string, fieldName: string): string {
  const sanitized = sanitizeEnvelopeText(value);
  if (!sanitized) {
    throw new Error(`Structured envelope ${fieldName} must not be empty`);
  }
  return sanitized;
}

function hasVisibleEnvelopeValue(value: StructuredEnvelopeValue): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  return typeof value !== "string" || value.trim().length > 0;
}

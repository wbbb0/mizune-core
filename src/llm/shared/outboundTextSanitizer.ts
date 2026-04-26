import { stripLeadingMessageHeaders } from "./messageHeaderFormat.ts";

const UNORDERED_LIST_MARKER_REGEX = /^(\s*)[-*+]\s+/gm;
const ORDERED_LIST_MARKER_REGEX = /^\s*\d+[.)]\s+/gm;
const STRUCTURED_BRACKET_LINE_REGEX = /^\s*⟦[^⟧]*⟧\s*(?:\r?\n)?/gm;
const FENCED_CODE_LINE_REGEX = /^\s*(`{3,}|~{3,}).*(?:\r?\n)?/gm;
const HEADING_MARKER_REGEX = /^\s{0,3}#{1,6}\s+/gm;
const BLOCKQUOTE_MARKER_REGEX = /^\s{0,3}>\s?/gm;
const MARKDOWN_RULE_OR_SETEXT_UNDERLINE_REGEX = /^\s*(?:={3,}|-{3,}|\*{3,}|_{3,})\s*(?:\r?\n)?/gm;

function stripInlineCode(text: string): string {
  return text.replace(/`([^`\n]+)`/g, "$1");
}

function stripEmphasis(text: string): string {
  let current = text;

  for (;;) {
    const next = current
      .replace(/(?<!\w)\*\*\*([^\n*](?:.*?[^\s*])?)\*\*\*(?!\w)/g, "$1")
      .replace(/(?<!\w)___([^\n_](?:.*?[^\s_])?)___(?!\w)/g, "$1")
      .replace(/(?<!\w)\*\*([^\n*](?:.*?[^\s*])?)\*\*(?!\w)/g, "$1")
      .replace(/(?<!\w)__([^\n_](?:.*?[^\s_])?)__(?!\w)/g, "$1")
      .replace(/(?<!\w)\*([^\n*](?:.*?[^\s*])?)\*(?!\w)/g, "$1")
      .replace(/(?<!\w)_([^\n_](?:.*?[^\s_])?)_(?!\w)/g, "$1");

    if (next === current) {
      return next;
    }
    current = next;
  }
}

function stripStructuredBracketOnlyLines(text: string): string {
  return text.replace(STRUCTURED_BRACKET_LINE_REGEX, "");
}

export function sanitizeStoredOutboundText(
  text: string,
  options?: {
    stripLeadingMessageHeaders?: boolean | undefined;
  }
): string {
  const strippedText = options?.stripLeadingMessageHeaders
    ? stripLeadingMessageHeaders(text)
    : text;
  return stripStructuredBracketOnlyLines(strippedText);
}

export function sanitizeOneBotOutboundText(
  text: string,
  options?: {
    stripLeadingMessageHeaders?: boolean | undefined;
  }
): string {
  const storedText = sanitizeStoredOutboundText(text, options);
  return stripEmphasis(
    stripInlineCode(
      storedText
        .replace(FENCED_CODE_LINE_REGEX, "")
        .replace(MARKDOWN_RULE_OR_SETEXT_UNDERLINE_REGEX, "")
        .replace(HEADING_MARKER_REGEX, "")
        .replace(BLOCKQUOTE_MARKER_REGEX, "")
        .replace(UNORDERED_LIST_MARKER_REGEX, "$1· ")
        .replace(ORDERED_LIST_MARKER_REGEX, "")
    )
  ).trim();
}

export function sanitizeOutboundText(
  text: string,
  options?: {
    stripLeadingMessageHeaders?: boolean | undefined;
  }
): string {
  return sanitizeOneBotOutboundText(text, options);
}

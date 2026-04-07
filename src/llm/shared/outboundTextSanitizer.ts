import { stripLeadingMessageHeaders } from "./messageHeaderFormat.ts";

const LIST_MARKER_REGEX = /^\s*(?:[-*+]|\d+[.)])\s+/gm;

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

export function sanitizeOutboundText(
  text: string,
  options?: {
    stripLeadingMessageHeaders?: boolean | undefined;
  }
): string {
  const strippedText = options?.stripLeadingMessageHeaders
    ? stripLeadingMessageHeaders(text)
    : text;
  return stripEmphasis(stripInlineCode(strippedText).replace(LIST_MARKER_REGEX, ""));
}

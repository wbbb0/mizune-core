import { buildOpenTag, buildCloseTag, escapeText } from "#utils/structuredEnvelope.ts";

export function renderPromptSection(name: string, lines: Array<string | null | undefined>): string | null {
  const visible = lines
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => escapeText(line));
  if (visible.length === 0) {
    return null;
  }
  return [buildOpenTag("section", { name }), ...visible, buildCloseTag("section")].join("\n");
}

export function renderPromptSectionRaw(name: string, lines: Array<string | null | undefined>): string | null {
  const visible = lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
  if (visible.length === 0) {
    return null;
  }
  return [buildOpenTag("section", { name }), ...visible, buildCloseTag("section")].join("\n");
}

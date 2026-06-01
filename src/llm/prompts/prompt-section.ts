import { buildOpenTag, buildCloseTag, escapeText } from "#utils/structuredEnvelope.ts";

export type PromptSectionPlacement =
  | "stable_system"
  | "capability_system"
  | "volatile_system";

export interface PromptSection {
  name: string;
  placement: PromptSectionPlacement;
  content: string;
}

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

export function buildPromptSection(
  name: string,
  lines: Array<string | null | undefined>,
  placement: PromptSectionPlacement
): PromptSection | null {
  const content = renderPromptSection(name, lines);
  return content ? { name, placement, content } : null;
}

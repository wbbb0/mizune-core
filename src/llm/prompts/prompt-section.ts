import { escapePromptBodyText } from "./prompt-escaping.ts";

export function renderPromptSection(name: string, lines: Array<string | null | undefined>): string | null {
  const visible = lines
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => escapePromptBodyText(line));
  if (visible.length === 0) {
    return null;
  }
  return [`⟦section name="${name}"⟧`, ...visible, "⟦/section⟧"].join("\n");
}

export function renderPromptSectionRaw(name: string, lines: Array<string | null | undefined>): string | null {
  const visible = lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
  if (visible.length === 0) {
    return null;
  }
  return [`⟦section name="${name}"⟧`, ...visible, "⟦/section⟧"].join("\n");
}

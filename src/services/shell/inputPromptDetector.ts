import type { TerminalInputPromptKind } from "./types.ts";

export interface TerminalInputCandidate {
  kind: TerminalInputPromptKind;
  promptText: string;
  confidence: "high" | "medium";
  signature: string;
}

const MAX_PROMPT_LINE_CHARS = 300;
const CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const SIMPLE_ESCAPE_PATTERN = /\u001b[@-Z\\-_]/g;

export function detectTerminalInputPrompt(input: string): TerminalInputCandidate | null {
  const normalized = normalizeTerminalOutput(input);
  const lines = getVisibleTailLines(normalized, 5);
  if (lines.length === 0) {
    return null;
  }

  const lastLine = lines[lines.length - 1]?.trimEnd() ?? "";
  const promptText = collectPromptText(lines);
  if (!lastLine.trim() || promptText.length > MAX_PROMPT_LINE_CHARS) {
    return null;
  }
  if (isExcludedPromptLine(lastLine)) {
    return null;
  }

  const strong = detectStrongPrompt(lastLine, promptText);
  if (strong) {
    return buildCandidate(strong, promptText, "high");
  }

  if (!looksLikeInteractiveLine(lastLine)) {
    return null;
  }

  const medium = detectMediumPrompt(lastLine, promptText);
  return medium ? buildCandidate(medium, promptText, "medium") : null;
}

export function normalizeTerminalOutput(input: string): string {
  return normalizeCarriageReturns(stripAnsi(input));
}

export function stripAnsi(input: string): string {
  return input
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(SIMPLE_ESCAPE_PATTERN, "");
}

export function normalizeCarriageReturns(input: string): string {
  const normalizedNewlines = input.replace(/\r\n/g, "\n");
  const rows: string[] = [];
  let current = "";
  for (const char of normalizedNewlines) {
    if (char === "\r") {
      current = "";
      continue;
    }
    if (char === "\n") {
      rows.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  rows.push(current);
  return rows.join("\n");
}

export function getVisibleTailLines(input: string, maxLines: number): string[] {
  return input
    .split("\n")
    .slice(-Math.max(1, maxLines))
    .filter((line) => line.trim().length > 0);
}

function collectPromptText(lines: string[]): string {
  const selected = lines.slice(-3);
  return selected.join("\n").trim();
}

function detectStrongPrompt(lastLine: string, promptText: string): TerminalInputPromptKind | null {
  if (/(password|passphrase|token|api key|otp|verification code).*[:：]?\s*$/i.test(lastLine)) {
    // TODO: Add sensitive-input handling before storing or replaying credentials/tokens.
    return "password";
  }
  if (/(\[[Yy]\/[Nn]\]|\[[Nn]\/[Yy]\]|\([Yy]es\/[Nn]o\)|\([Nn]o\/[Yy]es\)|continue\?|proceed\?|are you sure\?).*$/i.test(lastLine)) {
    return "confirmation";
  }
  if (/[❯›]\s+\S/.test(promptText) || /^\s*>\s+\S/.test(lastLine)) {
    return "selection";
  }
  return null;
}

function detectMediumPrompt(lastLine: string, promptText: string): TerminalInputPromptKind | null {
  if (/\?\s*$/.test(lastLine) || /^\s*\?\s+/.test(lastLine)) {
    if (/(select|choose|pick|option)/i.test(promptText)) {
      return "selection";
    }
    return "unknown_prompt";
  }
  if (/(enter|input|provide|type).+[:：]\s*$/i.test(lastLine)) {
    return "text_input";
  }
  if (/[:：]\s*$/.test(lastLine) && /(name|value|path|message|reason|branch|tag|version|input|enter)/i.test(lastLine)) {
    return "text_input";
  }
  return null;
}

function looksLikeInteractiveLine(line: string): boolean {
  const trimmed = line.trimEnd();
  return /(\?|\:|：|[❯›])\s*$/.test(trimmed)
    || /^\s*\?\s+/.test(trimmed)
    || /^\s*>\s+\S/.test(trimmed);
}

function isExcludedPromptLine(line: string): boolean {
  const trimmed = line.trim();
  if (/https?:\/\//i.test(trimmed)) {
    return true;
  }
  if (/^\s*at\s+.+:\d+:\d+\)?$/.test(trimmed)) {
    return true;
  }
  if (/\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|md):\d+(?::\d+)?\b/.test(trimmed)) {
    return true;
  }
  if (/^(error|warn|warning|info|debug|trace)\s*[:：]/i.test(trimmed)) {
    return true;
  }
  if (/^error\s+TS\d+\s*:/i.test(trimmed)) {
    return true;
  }
  return false;
}

function buildCandidate(
  kind: TerminalInputPromptKind,
  promptText: string,
  confidence: TerminalInputCandidate["confidence"]
): TerminalInputCandidate {
  const normalizedPrompt = promptText.trim();
  return {
    kind,
    promptText: normalizedPrompt,
    confidence,
    signature: `${kind}:${normalizedPrompt.slice(-240)}`
  };
}

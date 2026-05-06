import type { AppConfig } from "#config/config.ts";

export interface ShellCommandPolicyResult {
  decision: "allow" | "deny";
  reason: string | null;
  warnings: string[];
}

export function evaluateShellCommandPolicy(config: AppConfig, command: string): ShellCommandPolicyResult {
  const raw = String(command ?? "").trim();
  const normalized = normalizeCommand(raw);
  if (!normalized) {
    return {
      decision: "deny",
      reason: "command is required",
      warnings: []
    };
  }

  const segments = splitShellCommandSegments(raw)
    .map(normalizeCommand)
    .flatMap(expandPolicyComparableSegments);
  for (const prefix of config.shell.commandPolicy.denyPrefixes) {
    const normalizedPrefix = normalizeCommand(prefix).toLowerCase();
    if (normalizedPrefix && segments.some((segment) => segment.toLowerCase().startsWith(normalizedPrefix))) {
      return {
        decision: "deny",
        reason: `command denied by prefix policy: ${prefix}`,
        warnings: []
      };
    }
  }

  for (const denied of config.shell.commandPolicy.denyStandalone) {
    const normalizedDenied = normalizeCommand(denied).toLowerCase();
    if (normalizedDenied && segments.some((segment) => commandStartsWithWordBoundary(segment.toLowerCase(), normalizedDenied))) {
      return {
        decision: "deny",
        reason: `command denied by standalone policy: ${denied}`,
        warnings: []
      };
    }
  }

  const warnings = config.shell.commandPolicy.warnPatterns
    .map((pattern) => normalizeCommand(pattern))
    .filter((pattern) => pattern && normalized.toLowerCase().includes(pattern.toLowerCase()))
    .map((pattern) => `command matched warning pattern: ${pattern}`);

  return {
    decision: "allow",
    reason: null,
    warnings
  };
}

function normalizeCommand(value: string): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      current += char;
      quote = char;
      continue;
    }

    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      segments.push(current);
      current = "";
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) {
        index += 1;
      }
      continue;
    }

    current += char;
  }

  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function expandPolicyComparableSegments(segment: string): string[] {
  const comparable = [segment];
  const unwrapped = unwrapShellPolicyPrefixes(segment);
  if (unwrapped !== segment) {
    comparable.push(unwrapped);
  }
  return comparable;
}

function unwrapShellPolicyPrefixes(segment: string): string {
  let current = segment.trim();
  for (let index = 0; index < 8; index += 1) {
    const next = unwrapOneShellPolicyPrefix(current);
    if (next === current) {
      return current;
    }
    current = next.trim();
  }
  return current;
}

function unwrapOneShellPolicyPrefix(segment: string): string {
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens.length <= 1) {
    return segment;
  }
  const first = stripWrappingQuotes(tokens[0]!).toLowerCase();

  if (first === "sudo") {
    const commandIndex = findSudoCommandIndex(tokens);
    return commandIndex > 0 ? tokens.slice(commandIndex).join(" ") : segment;
  }

  if (first === "command" || first === "builtin" || first === "time") {
    return tokens.slice(1).join(" ");
  }

  if (first === "env") {
    const commandIndex = tokens.findIndex((token, index) => index > 0 && !isEnvAssignmentOrOption(token));
    return commandIndex > 0 ? tokens.slice(commandIndex).join(" ") : segment;
  }

  return segment;
}

function isEnvAssignmentOrOption(token: string): boolean {
  const normalized = stripWrappingQuotes(token);
  return normalized.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized);
}

function findSudoCommandIndex(tokens: string[]): number {
  const optionsWithValue = new Set([
    "-A",
    "-a",
    "-C",
    "-c",
    "-D",
    "-g",
    "-h",
    "-p",
    "-R",
    "-r",
    "-T",
    "-t",
    "-U",
    "-u"
  ]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripWrappingQuotes(tokens[index]!);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    if (token === "--") {
      return index + 1;
    }
    if (optionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return index;
  }
  return -1;
}

function stripWrappingQuotes(token: string): string {
  if (
    (token.startsWith("\"") && token.endsWith("\""))
    || (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function commandStartsWithWordBoundary(command: string, denied: string): boolean {
  return command === denied || command.startsWith(`${denied} `) || command.startsWith(`${denied};`);
}

import { randomInt } from "node:crypto";

const MAX_EXPRESSION_LENGTH = 160;
const MAX_TERM_COUNT = 40;
const MAX_DICE_PER_TERM = 200;
const MAX_TOTAL_DICE = 500;
const MAX_DICE_SIDES = 1_000_000;
const MAX_NUMBER_VALUE = 1_000_000_000;

export interface DiceParseError {
  ok: false;
  error: string;
}

export interface ParsedDiceExpression {
  ok: true;
  expression: string;
  terms: DiceExpressionTerm[];
}

export type DiceExpressionTerm = DiceTerm | NumberTerm;

export interface DiceTerm {
  kind: "dice";
  sign: 1 | -1;
  count: number;
  sides: number;
  notation: string;
}

export interface NumberTerm {
  kind: "number";
  sign: 1 | -1;
  value: number;
  notation: string;
}

export interface DiceRollResult {
  ok: true;
  expression: string;
  total: number;
  shortText: string;
  detailFormula: string;
  replyText: string;
  terms: DiceRollTermResult[];
  text: string;
}

export type DiceRollTermResult = DiceRollDiceTermResult | DiceRollNumberTermResult;

export interface DiceRollDiceTermResult {
  kind: "dice";
  sign: 1 | -1;
  notation: string;
  count: number;
  sides: number;
  rolls: number[];
  rawSubtotal: number;
  subtotal: number;
  display: string;
}

export interface DiceRollNumberTermResult {
  kind: "number";
  sign: 1 | -1;
  value: number;
  subtotal: number;
  display: string;
}

export type DiceRandomInt = (sides: number) => number;

export function parseDiceExpression(rawExpression: string): ParsedDiceExpression | DiceParseError {
  const input = normalizeAsciiSymbols(rawExpression).trim();
  if (!input) {
    return { ok: false, error: "expression is required" };
  }
  if (input.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: `expression is too long; max ${MAX_EXPRESSION_LENGTH} chars` };
  }

  const scanner = new DiceExpressionScanner(input);
  const terms: DiceExpressionTerm[] = [];
  let totalDice = 0;
  let expectingTerm = true;
  let pendingSign: 1 | -1 = 1;

  while (!scanner.done()) {
    scanner.skipSpaces();
    if (scanner.done()) {
      break;
    }

    if (expectingTerm) {
      const sign = scanner.consumeSign();
      if (sign) {
        pendingSign = sign;
        scanner.skipSpaces();
      }

      const parsed = scanner.consumeTerm(pendingSign);
      if (!parsed.ok) {
        return parsed;
      }
      if (terms.length >= MAX_TERM_COUNT) {
        return { ok: false, error: `too many terms; max ${MAX_TERM_COUNT}` };
      }
      if (parsed.term.kind === "dice") {
        totalDice += parsed.term.count;
        if (totalDice > MAX_TOTAL_DICE) {
          return { ok: false, error: `too many dice; max ${MAX_TOTAL_DICE}` };
        }
      }
      terms.push(parsed.term);
      expectingTerm = false;
      pendingSign = 1;
      continue;
    }

    const sign = scanner.consumeSign();
    if (!sign) {
      return { ok: false, error: `expected + or - at position ${scanner.position + 1}` };
    }
    pendingSign = sign;
    expectingTerm = true;
  }

  if (expectingTerm && terms.length > 0) {
    return { ok: false, error: "expression cannot end with an operator" };
  }
  if (terms.length === 0) {
    return { ok: false, error: "expression has no dice or number term" };
  }
  if (!terms.some((term) => term.kind === "dice")) {
    return { ok: false, error: "expression must include at least one dice term" };
  }

  return {
    ok: true,
    expression: formatNormalizedExpression(terms),
    terms
  };
}

export function rollDiceExpression(
  rawExpression: string,
  randomInteger: DiceRandomInt = rollCryptoInteger
): DiceRollResult | DiceParseError {
  const parsed = parseDiceExpression(rawExpression);
  if (!parsed.ok) {
    return parsed;
  }

  const terms: DiceRollTermResult[] = parsed.terms.map((term) => {
    if (term.kind === "number") {
      const subtotal = term.sign * term.value;
      return {
        kind: "number",
        sign: term.sign,
        value: term.value,
        subtotal,
        display: String(term.value)
      };
    }

    const rolls = Array.from({ length: term.count }, () => {
      const value = randomInteger(term.sides);
      if (!Number.isInteger(value) || value < 1 || value > term.sides) {
        throw new Error(`dice random integer must be within 1..${term.sides}`);
      }
      return value;
    });
    const rawSubtotal = rolls.reduce((sum, value) => sum + value, 0);
    const subtotal = term.sign * rawSubtotal;
    return {
      kind: "dice",
      sign: term.sign,
      notation: term.notation,
      count: term.count,
      sides: term.sides,
      rolls,
      rawSubtotal,
      subtotal,
      display: `(${rolls.join(" + ")})`
    };
  });
  const total = terms.reduce((sum, term) => sum + term.subtotal, 0);
  const detailFormula = formatDetailFormula(total, terms);
  const shortText = `${parsed.expression} = ${total}`;
  const replyText = `${parsed.expression}: ${detailFormula}`;

  return {
    ok: true,
    expression: parsed.expression,
    total,
    shortText,
    detailFormula,
    replyText,
    terms,
    text: replyText
  };
}

export function hasDiceRollSignal(text: string): boolean {
  const normalized = normalizeAsciiSymbols(text);
  for (const candidate of normalized.match(/[0-9dD%+\-\s]+/g) ?? []) {
    const trimmed = candidate.trim();
    if (!/[dD]/.test(trimmed)) {
      continue;
    }
    if (parseDiceExpression(trimmed).ok) {
      return true;
    }
  }

  return /(?:投|掷|擲|摇|搖|roll).{0,12}(?:骰|dice|die)/iu.test(normalized)
    || /(?:骰|dice).{0,12}(?:投|掷|擲|摇|搖|roll)/iu.test(normalized);
}

function rollCryptoInteger(sides: number): number {
  return randomInt(sides) + 1;
}

class DiceExpressionScanner {
  position = 0;

  constructor(private readonly input: string) {}

  done(): boolean {
    return this.position >= this.input.length;
  }

  skipSpaces(): void {
    while (this.input[this.position] === " " || this.input[this.position] === "\t") {
      this.position += 1;
    }
  }

  consumeSign(): 1 | -1 | null {
    const char = this.input[this.position];
    if (char === "+") {
      this.position += 1;
      return 1;
    }
    if (char === "-") {
      this.position += 1;
      return -1;
    }
    return null;
  }

  consumeTerm(sign: 1 | -1): { ok: true; term: DiceExpressionTerm } | DiceParseError {
    const start = this.position;
    const countDigits = this.consumeDigits();
    const maybeDiceMarker = this.input[this.position];

    if (maybeDiceMarker === "d" || maybeDiceMarker === "D") {
      this.position += 1;
      const count = countDigits ? parseInteger(countDigits) : 1;
      if (!Number.isSafeInteger(count) || count < 1) {
        return { ok: false, error: `invalid dice count at position ${start + 1}` };
      }
      if (count > MAX_DICE_PER_TERM) {
        return { ok: false, error: `too many dice in one term; max ${MAX_DICE_PER_TERM}` };
      }

      let sides: number;
      if (this.input[this.position] === "%") {
        this.position += 1;
        sides = 100;
      } else {
        const sideStart = this.position;
        const sideDigits = this.consumeDigits();
        if (!sideDigits) {
          return { ok: false, error: `dice sides are required at position ${sideStart + 1}` };
        }
        sides = parseInteger(sideDigits);
      }
      if (!Number.isSafeInteger(sides) || sides < 2) {
        return { ok: false, error: `dice sides must be at least 2 at position ${start + 1}` };
      }
      if (sides > MAX_DICE_SIDES) {
        return { ok: false, error: `dice sides too large; max ${MAX_DICE_SIDES}` };
      }

      return {
        ok: true,
        term: {
          kind: "dice",
          sign,
          count,
          sides,
          notation: `${count}D${sides}`
        }
      };
    }

    if (!countDigits) {
      return { ok: false, error: `expected dice or number at position ${start + 1}` };
    }
    const value = parseInteger(countDigits);
    if (!Number.isSafeInteger(value) || value > MAX_NUMBER_VALUE) {
      return { ok: false, error: `number too large; max ${MAX_NUMBER_VALUE}` };
    }

    return {
      ok: true,
      term: {
        kind: "number",
        sign,
        value,
        notation: String(value)
      }
    };
  }

  private consumeDigits(): string {
    const start = this.position;
    while (isDigit(this.input[this.position])) {
      this.position += 1;
    }
    return this.input.slice(start, this.position);
  }
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

function isDigit(value: string | undefined): boolean {
  return value != null && value >= "0" && value <= "9";
}

function normalizeAsciiSymbols(value: string): string {
  return String(value ?? "")
    .replace(/[Ｄｄ]/g, (char) => char === "Ｄ" ? "D" : "d")
    .replace(/[＋]/g, "+")
    .replace(/[－−]/g, "-")
    .replace(/[％]/g, "%")
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10));
}

function formatNormalizedExpression(terms: DiceExpressionTerm[]): string {
  return terms.map((term, index) => {
    const prefix = term.sign < 0 ? "-" : (index === 0 ? "" : "+");
    return `${prefix}${term.notation}`;
  }).join("");
}

function formatDetailFormula(
  total: number,
  terms: DiceRollTermResult[]
): string {
  const detail = terms
    .map((term, index) => {
      const value = term.display;
      if (index === 0) {
        return term.sign < 0 ? `-${value}` : value;
      }
      return term.sign < 0 ? `- ${value}` : `+ ${value}`;
    })
    .join(" ");
  return `${detail} = ${total}`;
}

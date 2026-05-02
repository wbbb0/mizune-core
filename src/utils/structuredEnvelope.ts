export const STRUCTURED_ENVELOPE_OPEN = "⟦";
export const STRUCTURED_ENVELOPE_CLOSE = "⟧";

export type StructuredEnvelopeValue = string | number | boolean | null | undefined;

export interface StructuredEnvelopeField {
  label: string;
  value: StructuredEnvelopeValue;
}

const RESERVED_ENVELOPE_CHARS = /[⟦⟧]/g;
const WHITESPACE_REGEX = /\s+/g;

export function formatStructuredEnvelope(input: {
  title: string;
  fields: readonly StructuredEnvelopeField[];
}): string {
  const title = sanitizeRequiredEnvelopeText(input.title, "title");
  const lines = [
    title,
    ...input.fields
      .filter((field) => hasVisibleEnvelopeValue(field.value))
      .map((field) => {
        const label = sanitizeRequiredEnvelopeText(field.label, "field label");
        return `${label}: ${sanitizeEnvelopeText(String(field.value))}`;
      })
  ];
  return `${STRUCTURED_ENVELOPE_OPEN}${lines.join("\n")}\n${STRUCTURED_ENVELOPE_CLOSE}`;
}

export function sanitizeEnvelopeText(value: string): string {
  return value
    .replace(WHITESPACE_REGEX, " ")
    .trim()
    .replace(RESERVED_ENVELOPE_CHARS, replaceEnvelopeDelimiter);
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

function replaceEnvelopeDelimiter(char: string): string {
  return char === STRUCTURED_ENVELOPE_OPEN ? "［" : "］";
}

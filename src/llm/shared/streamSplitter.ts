export interface ReadySegment {
  text: string;
  joinWithDoubleNewline: boolean;
}

export interface SplitResult {
  ready: ReadySegment[];
  rest: string;
}

const SENTENCE_ENDINGS = new Set(["。", "！", "？", "!", "?", ";", "；"]);
const CLOSERS = new Set(["\"", "'", "”", "’", "）", ")", "]", "】"]);
const MIN_CHUNK_LENGTH = 12;
const LIST_MARKER_REGEX = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCKQUOTE_MARKER_REGEX = /^\s{0,3}>\s?/;
const TABLE_SEPARATOR_REGEX = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const FENCE_START_REGEX = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

interface LineInfo {
  text: string;
  end: number;
  hasTrailingNewline: boolean;
}

interface ConsumedBlock {
  text: string;
  next: number;
}

export function splitReadySegments(buffer: string): SplitResult {
  const ready: ReadySegment[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    cursor = skipBlankLines(buffer, cursor);
    if (cursor >= buffer.length) {
      break;
    }

    const markdownBlock = consumeMarkdownBlock(buffer, cursor);
    if (markdownBlock === "incomplete") {
      break;
    }
    if (markdownBlock != null) {
      ready.push({
        text: trimOuterNewlines(markdownBlock.text),
        joinWithDoubleNewline: true
      });
      cursor = markdownBlock.next;
      continue;
    }

    const plainSegment = consumePlainSegment(buffer, cursor);
    if (plainSegment == null) {
      break;
    }
    ready.push(plainSegment.segment);
    cursor = plainSegment.next;
  }

  return {
    ready,
    rest: buffer.slice(cursor)
  };
}

function consumeMarkdownBlock(buffer: string, start: number): ConsumedBlock | "incomplete" | null {
  const fenced = consumeFencedBlock(buffer, start);
  if (fenced != null) {
    return fenced;
  }

  const line = readLine(buffer, start);
  if (line == null) {
    return null;
  }

  if (BLOCKQUOTE_MARKER_REGEX.test(line.text)) {
    return consumeContinuousBlock(buffer, start, (currentLine) => BLOCKQUOTE_MARKER_REGEX.test(currentLine.text));
  }

  if (LIST_MARKER_REGEX.test(line.text)) {
    return consumeContinuousBlock(buffer, start, (currentLine, previousMatched) => {
      if (LIST_MARKER_REGEX.test(currentLine.text)) {
        return true;
      }
      if (!previousMatched) {
        return false;
      }
      if (isBlankLine(currentLine.text)) {
        return true;
      }
      return /^[ \t]+/.test(currentLine.text);
    });
  }

  if (isTableHeaderLine(line.text)) {
    const nextLine = readLine(buffer, line.end);
    if (nextLine == null) {
      return "incomplete";
    }
    if (TABLE_SEPARATOR_REGEX.test(nextLine.text)) {
      return consumeContinuousBlock(
        buffer,
        start,
        (currentLine, previousMatched, lineIndex) => {
          if (lineIndex <= 1) {
            return true;
          }
          return /\|/.test(currentLine.text) && !isBlankLine(currentLine.text);
        }
      );
    }
  }

  return null;
}

function consumeFencedBlock(buffer: string, start: number): ConsumedBlock | "incomplete" | null {
  const openingLine = readLine(buffer, start);
  if (openingLine == null) {
    return null;
  }
  const openingFence = openingLine.text.match(FENCE_START_REGEX);
  if (openingFence == null) {
    return null;
  }

  const fenceToken = openingFence[1] ?? "";
  const fenceChar = fenceToken[0] ?? "";
  const fenceLength = fenceToken.length;
  let cursor = openingLine.end;

  while (cursor < buffer.length) {
    const line = readLine(buffer, cursor);
    if (line == null) {
      break;
    }
    if (isClosingFence(line.text, fenceChar, fenceLength)) {
      return {
        text: buffer.slice(start, line.end).replace(/\n+$/, ""),
        next: line.end
      };
    }
    cursor = line.end;
  }

  return "incomplete";
}

function consumeContinuousBlock(
  buffer: string,
  start: number,
  matcher: (line: LineInfo, previousMatched: boolean, lineIndex: number) => boolean
): ConsumedBlock | "incomplete" {
  let cursor = start;
  let lastMatchedEnd = start;
  let lineIndex = 0;
  let previousMatched = false;

  while (cursor < buffer.length) {
    const line = readLine(buffer, cursor);
    if (line == null) {
      break;
    }
    const matched = matcher(line, previousMatched, lineIndex);
    if (!matched) {
      return {
        text: buffer.slice(start, lastMatchedEnd).replace(/\n+$/, ""),
        next: lastMatchedEnd
      };
    }
    lastMatchedEnd = line.end;
    previousMatched = !isBlankLine(line.text);
    cursor = line.end;
    lineIndex += 1;
  }

  return "incomplete";
}

function consumePlainSegment(
  buffer: string,
  start: number
): { segment: ReadySegment; next: number } | null {
  for (let index = start; index < buffer.length; index += 1) {
    if (buffer[index] === "\n") {
      const chunk = buffer.slice(start, index).trim();
      const next = skipBlankLines(buffer, index + 1);
      if (!chunk) {
        return next > index + 1
          ? {
              segment: {
                text: "",
                joinWithDoubleNewline: true
              },
              next
            }
          : null;
      }
      return {
        segment: {
          text: chunk,
          joinWithDoubleNewline: true
        },
        next
      };
    }

    if (!SENTENCE_ENDINGS.has(buffer[index] ?? "")) {
      continue;
    }

    let end = index + 1;
    while (end < buffer.length && CLOSERS.has(buffer[end] ?? "")) {
      end += 1;
    }

    const chunk = buffer.slice(start, end).trim();
    if (chunk && chunk.length >= MIN_CHUNK_LENGTH) {
      return {
        segment: {
          text: chunk,
          joinWithDoubleNewline: false
        },
        next: end
      };
    }
  }

  return null;
}

function readLine(buffer: string, start: number): LineInfo | null {
  if (start >= buffer.length) {
    return null;
  }
  const newlineIndex = buffer.indexOf("\n", start);
  if (newlineIndex === -1) {
    return {
      text: buffer.slice(start),
      end: buffer.length,
      hasTrailingNewline: false
    };
  }
  return {
    text: buffer.slice(start, newlineIndex),
    end: newlineIndex + 1,
    hasTrailingNewline: true
  };
}

function skipBlankLines(buffer: string, start: number): number {
  let cursor = start;
  while (cursor < buffer.length) {
    const line = readLine(buffer, cursor);
    if (line == null || !isBlankLine(line.text)) {
      break;
    }
    cursor = line.end;
  }
  return cursor;
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function isClosingFence(line: string, fenceChar: string, fenceLength: number): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith(fenceChar.repeat(fenceLength))) {
    return false;
  }
  return new RegExp(`^${escapeForRegex(fenceChar)}{${fenceLength},}[ \\t]*$`).test(trimmed);
}

function isTableHeaderLine(line: string): boolean {
  return /\|/.test(line) && !isBlankLine(line);
}

function trimOuterNewlines(value: string): string {
  return value.replace(/^\n+/, "").replace(/\n+$/, "");
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

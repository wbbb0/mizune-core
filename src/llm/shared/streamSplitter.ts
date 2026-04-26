export interface ReadySegment {
  text: string;
  joinWithDoubleNewline: boolean;
}

export interface SplitResult {
  ready: ReadySegment[];
  readyConsumedEnds: number[];
  rest: string;
}

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

type BlockKind = "paragraph" | "markdown" | "ignored";

interface NaturalBlock extends ConsumedBlock {
  kind: BlockKind;
  complete: boolean;
}

export function splitReadySegments(buffer: string): SplitResult {
  const ready: ReadySegment[] = [];
  const readyConsumedEnds: number[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    cursor = skipBlankLines(buffer, cursor);
    if (cursor >= buffer.length) {
      break;
    }

    const segment = consumeNaturalSegment(buffer, cursor);
    if (segment == null) {
      break;
    }
    if (segment.text.trim()) {
      ready.push({
        text: trimOuterNewlines(segment.text),
        joinWithDoubleNewline: true
      });
      cursor = segment.next;
      readyConsumedEnds.push(cursor);
      continue;
    }
    cursor = segment.next;
  }

  return {
    ready,
    readyConsumedEnds,
    rest: buffer.slice(cursor)
  };
}

function consumeNaturalSegment(buffer: string, start: number): ConsumedBlock | null {
  let cursor = start;
  let segmentEnd = start;
  let blockCount = 0;
  let attachedAfterParagraph = false;

  while (cursor < buffer.length) {
    const previousSegmentEnd = segmentEnd;
    const block = consumeNaturalBlock(buffer, cursor);
    if (block == null || !block.complete) {
      return null;
    }

    if (block.kind === "ignored") {
      return {
        text: buffer.slice(start, previousSegmentEnd),
        next: skipBlankLines(buffer, block.next)
      };
    }

    blockCount += 1;
    segmentEnd = block.next;
    cursor = block.next;

    const afterBlankLines = skipBlankLines(buffer, cursor);
    const hasParagraphBoundary = afterBlankLines > cursor;
    if (!hasParagraphBoundary) {
      if (block.kind === "markdown" && block.next < buffer.length) {
        return {
          text: buffer.slice(start, segmentEnd),
          next: segmentEnd
        };
      }
      return null;
    }

    const nextBlock = consumeNaturalBlock(buffer, afterBlankLines);
    if (nextBlock == null) {
      return {
        text: buffer.slice(start, segmentEnd),
        next: afterBlankLines
      };
    }

    if (
      blockCount === 1
      && block.kind === "paragraph"
      && nextBlock.kind === "markdown"
    ) {
      cursor = afterBlankLines;
      segmentEnd = cursor;
      attachedAfterParagraph = true;
      continue;
    }

    if (attachedAfterParagraph && block.kind === "markdown") {
      return {
        text: buffer.slice(start, segmentEnd),
        next: afterBlankLines
      };
    }

    return {
      text: buffer.slice(start, segmentEnd),
      next: afterBlankLines
    };
  }

  return null;
}

function consumeNaturalBlock(buffer: string, start: number): NaturalBlock | null {
  const markdownBlock = consumeMarkdownBlock(buffer, start);
  if (markdownBlock === "incomplete") {
    return {
      kind: "markdown",
      text: buffer.slice(start),
      next: buffer.length,
      complete: false
    };
  }
  if (markdownBlock != null) {
    return {
      kind: markdownBlock.text.trim() ? "markdown" : "ignored",
      ...markdownBlock,
      complete: true
    };
  }

  const paragraph = consumeParagraphBlock(buffer, start);
  return paragraph
    ? {
        kind: "paragraph",
        ...paragraph,
        complete: true
      }
    : null;
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

  if (isThematicBreakLine(line.text)) {
    return {
      text: "",
      next: line.end
    };
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

function consumeParagraphBlock(buffer: string, start: number): ConsumedBlock | null {
  let cursor = start;
  let lastLineEnd = start;

  while (cursor < buffer.length) {
    const line = readLine(buffer, cursor);
    if (line == null || isBlankLine(line.text)) {
      break;
    }
    if (cursor !== start && startsMarkdownBlock(line.text)) {
      break;
    }
    lastLineEnd = line.end;
    cursor = line.end;
  }

  if (lastLineEnd <= start) {
    return null;
  }

  return {
    text: buffer.slice(start, lastLineEnd).replace(/\n+$/, ""),
    next: lastLineEnd
  };
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

function startsMarkdownBlock(line: string): boolean {
  return FENCE_START_REGEX.test(line)
    || isThematicBreakLine(line)
    || BLOCKQUOTE_MARKER_REGEX.test(line)
    || LIST_MARKER_REGEX.test(line)
    || isTableHeaderLine(line);
}

function isThematicBreakLine(line: string): boolean {
  const compact = line.trim().replace(/[ \t]+/g, "");
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(compact);
}

function trimOuterNewlines(value: string): string {
  return value.replace(/^\n+/, "").replace(/\n+$/, "");
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

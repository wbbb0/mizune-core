import sharp from "sharp";
import { sanitizeOneBotOutboundText } from "#llm/shared/outboundTextSanitizer.ts";
import type { OneBotMessageSegment } from "#services/onebot/types.ts";

const TABLE_DELIMITER_CELL_REGEX = /^:?-{3,}:?$/;
const FENCE_START_REGEX = /^\s{0,3}(`{3,}|~{3,})/;
const MAX_COLUMNS = 12;
const MAX_ROWS = 200;
const MAX_CELL_CHARACTERS = 600;
const MAX_CELL_SOURCE_LINES = 12;
const MAX_IMAGE_WIDTH = 2_000;
const MAX_IMAGE_HEIGHT = 3_600;
const CELL_HORIZONTAL_PADDING = 16;
const CELL_VERTICAL_PADDING = 12;
const FONT_SIZE = 24;
const LINE_HEIGHT = 34;
const MIN_COLUMN_WIDTH = 110;
const MAX_COLUMN_WIDTH = 360;

type TableAlignment = "left" | "center" | "right";

export interface MarkdownTable {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
  raw: string;
}

export type MarkdownTableBlock =
  | { kind: "text"; text: string }
  | { kind: "table"; table: MarkdownTable };

export interface OneBotMarkdownTableDelivery {
  segments: OneBotMessageSegment[];
  pacingText: string;
  sentLogText: string;
  renderedTableCount: number;
  renderErrors: string[];
}

interface ParsedRow {
  cells: string[];
  hasSeparator: boolean;
}

interface RenderedCell {
  lines: string[];
}

interface RenderedRow {
  cells: RenderedCell[];
  height: number;
  header: boolean;
  alternate: boolean;
}

export function splitMarkdownTableBlocks(markdown: string): MarkdownTableBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownTableBlock[] = [];
  const textLines: string[] = [];
  let fence: { char: string; length: number } | null = null;

  const flushText = () => {
    if (textLines.length === 0) {
      return;
    }
    const text = textLines.join("\n");
    if (text) {
      blocks.push({ kind: "text", text });
    }
    textLines.length = 0;
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (fence != null) {
      textLines.push(line);
      if (isClosingFence(line, fence)) {
        fence = null;
      }
      index += 1;
      continue;
    }

    const fenceMatch = line.match(FENCE_START_REGEX);
    if (fenceMatch != null) {
      const token = fenceMatch[1] ?? "";
      fence = { char: token[0] ?? "`", length: token.length };
      textLines.push(line);
      index += 1;
      continue;
    }

    const header = parseTableRow(line);
    const delimiterLine = lines[index + 1];
    const delimiter = delimiterLine == null ? null : parseTableRow(delimiterLine);
    if (
      header.hasSeparator
      && delimiter?.hasSeparator === true
      && header.cells.length > 0
      && delimiter.cells.length === header.cells.length
      && delimiter.cells.every((cell) => TABLE_DELIMITER_CELL_REGEX.test(cell.trim()))
    ) {
      flushText();
      const tableLines = [line, delimiterLine];
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index] ?? "";
        if (!rowLine.trim()) {
          break;
        }
        const row = parseTableRow(rowLine);
        if (!row.hasSeparator || row.cells.length !== header.cells.length) {
          break;
        }
        tableLines.push(rowLine);
        rows.push(row.cells.map(normalizeCellText));
        index += 1;
      }
      blocks.push({
        kind: "table",
        table: {
          headers: header.cells.map(normalizeCellText),
          alignments: delimiter.cells.map(parseAlignment),
          rows,
          raw: tableLines.join("\n")
        }
      });
      continue;
    }

    textLines.push(line);
    index += 1;
  }

  flushText();
  return blocks;
}

export async function buildOneBotMarkdownTableDelivery(
  markdown: string
): Promise<OneBotMarkdownTableDelivery | null> {
  const blocks = splitMarkdownTableBlocks(markdown);
  if (!blocks.some((block) => block.kind === "table")) {
    return null;
  }

  const segments: OneBotMessageSegment[] = [];
  const logParts: string[] = [];
  const renderErrors: string[] = [];
  let renderedTableCount = 0;

  for (const block of blocks) {
    if (block.kind === "text") {
      const text = sanitizeOneBotOutboundText(block.text).trim();
      if (text) {
        segments.push({ type: "text", data: { text } });
        logParts.push(text);
      }
      continue;
    }

    try {
      const images = await renderMarkdownTablePng(block.table);
      for (const image of images) {
        segments.push({
          type: "image",
          data: { file: `base64://${image.toString("base64")}` }
        });
      }
      renderedTableCount += 1;
      logParts.push(images.length === 1 ? "[表格图片]" : `[表格图片×${images.length}]`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      renderErrors.push(message);
      const fallback = formatTableFallback(block.table);
      segments.push({ type: "text", data: { text: fallback } });
      logParts.push(fallback);
    }
  }

  const sentLogText = logParts.join("\n\n").trim() || "[表格图片]";
  return {
    segments,
    pacingText: sanitizeOneBotOutboundText(markdown).trim() || sentLogText,
    sentLogText,
    renderedTableCount,
    renderErrors
  };
}

export async function renderMarkdownTablePng(table: MarkdownTable): Promise<Buffer[]> {
  const normalized = limitTableSize(table);
  const columnWidths = calculateColumnWidths(normalized);
  const header = createRenderedRow(normalized.headers, columnWidths, true, false);
  const rows = normalized.rows.map((row, index) =>
    createRenderedRow(row, columnWidths, false, index % 2 === 1)
  );
  const pages = paginateRows(header, rows);
  return await Promise.all(pages.map(async (page) => {
    const svg = renderTableSvg(page, columnWidths, normalized.alignments);
    return await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  }));
}

function parseTableRow(line: string): ParsedRow {
  const cells: string[] = [];
  let cell = "";
  let hasSeparator = false;
  let codeFenceLength = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === "\\" && index + 1 < line.length) {
      cell += line[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (line[index + runLength] === "`") {
        runLength += 1;
      }
      if (codeFenceLength === 0) {
        codeFenceLength = runLength;
      } else if (codeFenceLength === runLength) {
        codeFenceLength = 0;
      }
      cell += "`".repeat(runLength);
      index += runLength - 1;
      continue;
    }
    if (character === "|" && codeFenceLength === 0) {
      cells.push(cell.trim());
      cell = "";
      hasSeparator = true;
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());

  if (line.trimStart().startsWith("|")) {
    cells.shift();
  }
  if (line.trimEnd().endsWith("|")) {
    cells.pop();
  }
  return { cells, hasSeparator };
}

function normalizeCellText(value: string): string {
  return sanitizeOneBotOutboundText(
    value
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/\[([^\]]+)]\((?:[^()\s]+|\([^)]*\))+\)/g, "$1")
  ).trim();
}

function parseAlignment(value: string): TableAlignment {
  const trimmed = value.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) {
    return "center";
  }
  return trimmed.endsWith(":") ? "right" : "left";
}

function isClosingFence(line: string, fence: { char: string; length: number }): boolean {
  const escaped = fence.char === "`" ? "`" : "~";
  return new RegExp(`^\\s{0,3}${escaped}{${fence.length},}\\s*$`).test(line);
}

function limitTableSize(table: MarkdownTable): MarkdownTable {
  let headers = table.headers.slice(0, MAX_COLUMNS).map(limitCellText);
  let alignments = table.alignments.slice(0, MAX_COLUMNS);
  let rows = table.rows.map((row) => row.slice(0, MAX_COLUMNS).map(limitCellText));

  if (table.headers.length > MAX_COLUMNS) {
    headers[MAX_COLUMNS - 1] = "其余列";
    alignments[MAX_COLUMNS - 1] = "left";
    rows = table.rows.map((row) => [
      ...row.slice(0, MAX_COLUMNS - 1).map(limitCellText),
      limitCellText(row.slice(MAX_COLUMNS - 1).join("；"))
    ]);
  }
  if (rows.length > MAX_ROWS) {
    const omitted = rows.length - MAX_ROWS;
    rows = rows.slice(0, MAX_ROWS);
    rows.push([`另有 ${omitted} 行未显示`, ...headers.slice(1).map(() => "")]);
  }
  return { ...table, headers, alignments, rows };
}

function calculateColumnWidths(table: MarkdownTable): number[] {
  const preferredWidths = table.headers.map((header, columnIndex) => {
    const values = [header, ...table.rows.map((row) => row[columnIndex] ?? "")];
    const widestUnits = Math.max(...values.flatMap((value) =>
      value.split("\n").map(measureDisplayUnits)
    ));
    const preferred = Math.ceil(widestUnits * FONT_SIZE * 0.56) + CELL_HORIZONTAL_PADDING * 2;
    return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, preferred));
  });
  const totalWidth = preferredWidths.reduce((total, width) => total + width, 0);
  if (totalWidth <= MAX_IMAGE_WIDTH) {
    return preferredWidths;
  }
  const minimumTotal = preferredWidths.length * MIN_COLUMN_WIDTH;
  const flexibleTotal = totalWidth - minimumTotal;
  const availableFlexibleWidth = MAX_IMAGE_WIDTH - minimumTotal;
  return preferredWidths.map((width) => Math.floor(
    MIN_COLUMN_WIDTH + (width - MIN_COLUMN_WIDTH) * availableFlexibleWidth / flexibleTotal
  ));
}

function limitCellText(value: string): string {
  const sourceLines = value.split("\n");
  const limitedLines = sourceLines.slice(0, MAX_CELL_SOURCE_LINES);
  let text = limitedLines.join("\n");
  const omitted = sourceLines.length > limitedLines.length || Array.from(text).length > MAX_CELL_CHARACTERS;
  text = Array.from(text).slice(0, MAX_CELL_CHARACTERS).join("");
  return omitted ? `${text}…` : text;
}

function createRenderedRow(
  values: string[],
  columnWidths: number[],
  header: boolean,
  alternate: boolean
): RenderedRow {
  const cells = columnWidths.map((width, index) => ({
    lines: wrapCellText(values[index] ?? "", width)
  }));
  const lineCount = Math.max(1, ...cells.map((cell) => cell.lines.length));
  return {
    cells,
    height: lineCount * LINE_HEIGHT + CELL_VERTICAL_PADDING * 2,
    header,
    alternate
  };
}

function wrapCellText(value: string, columnWidth: number): string[] {
  const maxUnits = Math.max(4, Math.floor(
    (columnWidth - CELL_HORIZONTAL_PADDING * 2) / (FONT_SIZE * 0.56)
  ));
  const output: string[] = [];
  for (const sourceLine of value.split("\n")) {
    let current = "";
    let currentUnits = 0;
    for (const character of Array.from(sourceLine)) {
      const units = measureDisplayUnits(character);
      if (current && currentUnits + units > maxUnits) {
        output.push(current);
        current = "";
        currentUnits = 0;
      }
      current += character;
      currentUnits += units;
    }
    output.push(current || " ");
  }
  return output;
}

function measureDisplayUnits(value: string): number {
  let units = 0;
  for (const character of Array.from(value)) {
    units += /[\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af]|\p{Extended_Pictographic}/u.test(character)
      ? 2
      : 1;
  }
  return units;
}

function paginateRows(header: RenderedRow, rows: RenderedRow[]): RenderedRow[][] {
  const pages: RenderedRow[][] = [];
  let page: RenderedRow[] = [header];
  let height = header.height;
  for (const row of rows) {
    if (page.length > 1 && height + row.height > MAX_IMAGE_HEIGHT) {
      pages.push(page);
      page = [header];
      height = header.height;
    }
    page.push(row);
    height += row.height;
  }
  pages.push(page);
  return pages;
}

function renderTableSvg(
  rows: RenderedRow[],
  columnWidths: number[],
  alignments: TableAlignment[]
): string {
  const width = columnWidths.reduce((total, value) => total + value, 0) + 2;
  const height = rows.reduce((total, row) => total + row.height, 0) + 2;
  const elements: string[] = [
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`
  ];
  let y = 1;

  for (const row of rows) {
    let x = 1;
    const fill = row.header ? "#e8eef8" : row.alternate ? "#f7f9fc" : "#ffffff";
    for (let columnIndex = 0; columnIndex < columnWidths.length; columnIndex += 1) {
      const columnWidth = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
      const cell = row.cells[columnIndex] ?? { lines: [" "] };
      const alignment = row.header ? "left" : alignments[columnIndex] ?? "left";
      const anchor = alignment === "center" ? "middle" : alignment === "right" ? "end" : "start";
      const textX = alignment === "center"
        ? x + columnWidth / 2
        : alignment === "right"
          ? x + columnWidth - CELL_HORIZONTAL_PADDING
          : x + CELL_HORIZONTAL_PADDING;
      elements.push(
        `<rect x="${x}" y="${y}" width="${columnWidth}" height="${row.height}" fill="${fill}" stroke="#c7d0df" stroke-width="1"/>`
      );
      const firstBaseline = y + CELL_VERTICAL_PADDING + FONT_SIZE;
      const tspans = cell.lines.map((line, lineIndex) =>
        `<tspan x="${textX}" y="${firstBaseline + lineIndex * LINE_HEIGHT}">${escapeXml(line)}</tspan>`
      ).join("");
      elements.push(
        `<text text-anchor="${anchor}" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="${FONT_SIZE}" font-weight="${row.header ? 600 : 400}" fill="#172033">${tspans}</text>`
      );
      x += columnWidth;
    }
    y += row.height;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join("")}</svg>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatTableFallback(table: MarkdownTable): string {
  const rows = table.rows.slice(0, MAX_ROWS);
  const lines = [table.headers.join(" ｜ ")];
  for (const row of rows) {
    lines.push(row.join(" ｜ "));
  }
  if (table.rows.length > rows.length) {
    lines.push(`……另有 ${table.rows.length - rows.length} 行`);
  }
  return lines.join("\n");
}

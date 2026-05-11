import type { MediaSemanticKind } from "#services/onebot/messageSegments.ts";
import { parseProtocolLine } from "#utils/structuredEnvelope.ts";

export interface StructuredMediaReference {
  kind: MediaSemanticKind;
  imageId: string;
}

export function extractStructuredMediaReferences(content: string): StructuredMediaReference[] {
  const refs: StructuredMediaReference[] = [];
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const parsed = parseProtocolLine(line);
    if (!parsed || parsed.tag !== "ref" || (parsed.attrs.kind !== "image" && parsed.attrs.kind !== "emoji")) {
      continue;
    }
    const kind = parsed.attrs.kind === "emoji" ? "emoji" : "image";
    const imageId = String(parsed.attrs.image_id ?? "").trim();
    if (!imageId || imageId === "omitted") {
      continue;
    }
    refs.push({ kind, imageId });
  }
  return refs;
}

export function extractStructuredMediaIds(content: string): string[] {
  return Array.from(new Set(extractStructuredMediaReferences(content).map((item) => item.imageId)));
}

export function annotateStructuredMediaReferences(
  content: string,
  captions: ReadonlyMap<string, string>,
  options?: {
    includeIds?: boolean;
  }
): string {
  const includeIds = options?.includeIds !== false;

  return content.replace(/\r\n/g, "\n").split("\n").map((line) => {
    const parsed = parseProtocolLine(line);
    if (!parsed || parsed.tag !== "ref" || (parsed.attrs.kind !== "image" && parsed.attrs.kind !== "emoji")) {
      return line;
    }
    const kind: MediaSemanticKind = parsed.attrs.kind === "emoji" ? "emoji" : "image";
    const imageId = String(parsed.attrs.image_id ?? "").trim();
    const caption = captions.get(imageId);
    const label = kind === "emoji" ? "表情" : "图片";

    if (imageId === "omitted") {
      return includeIds ? line : `${label}：<已省略>`;
    }

    if (!caption) {
      return includeIds ? line : `${label}`;
    }

    return includeIds
      ? `${line}\n${label}描述：${caption}`
      : `${label}描述：${caption}`;
  }).join("\n");
}

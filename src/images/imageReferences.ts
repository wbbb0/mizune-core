import type { MediaSemanticKind } from "#services/onebot/messageSegments.ts";

export interface StructuredMediaReference {
  kind: MediaSemanticKind;
  imageId: string;
}

const STRUCTURED_MEDIA_REF_REGEX = /⟦ref\s+kind="(image|emoji)"\s+image_id="([^"]+)"\s*⟧/gi;

export function extractStructuredMediaReferences(content: string): StructuredMediaReference[] {
  const refs: StructuredMediaReference[] = [];
  let match: RegExpExecArray | null;
  while ((match = STRUCTURED_MEDIA_REF_REGEX.exec(content)) != null) {
    const kind = String(match[1] ?? "").trim() === "emoji" ? "emoji" : "image";
    const imageId = String(match[2] ?? "").trim();
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

  return content.replace(STRUCTURED_MEDIA_REF_REGEX, (_full, rawKind, rawImageId) => {
    const kind: MediaSemanticKind = String(rawKind ?? "").trim() === "emoji" ? "emoji" : "image";
    const imageId = String(rawImageId ?? "").trim();
    const caption = captions.get(imageId);
    const label = kind === "emoji" ? "表情" : "图片";

    if (imageId === "omitted") {
      return includeIds ? _full : `${label}：<已省略>`;
    }

    if (!caption) {
      return includeIds ? _full : `${label}`;
    }

    return includeIds
      ? `${_full}\n${label}描述：${caption}`
      : `${label}描述：${caption}`;
  });
}

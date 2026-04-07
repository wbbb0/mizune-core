import { annotateStructuredMediaReferences, extractStructuredMediaIds } from "./imageReferences.ts";

export interface PromptImageCaption {
  imageId: string;
  caption: string;
}

export function collectReferencedImageIds(messages: Array<{ content: string }>): string[] {
  return Array.from(new Set(messages.flatMap((message) => extractStructuredMediaIds(message.content))));
}

export function annotateHistoryMessagesWithCaptions(
  messages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>,
  captions: ReadonlyMap<string, string>,
  options?: {
    includeIds?: boolean;
  }
): Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }> {
  return messages.map((message) => ({
    ...message,
    content: annotateStructuredMediaReferences(message.content, captions, options)
  }));
}

export function buildPromptImageCaptions(
  imageIds: string[],
  captions: ReadonlyMap<string, string>
): PromptImageCaption[] {
  return imageIds
    .map((imageId) => {
      const caption = captions.get(imageId);
      if (!caption) {
        return null;
      }
      return {
        imageId,
        caption
      };
    })
    .filter((item): item is PromptImageCaption => item != null);
}

export interface ComposerAttachment {
  fileId: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  fileRef?: string | null;
  sourceName?: string;
  chatFilePath?: string | null;
  mimeType?: string;
  sizeBytes?: number;
}

export interface ComposerSendPayload {
  userId: string;
  text: string;
  imageIds: string[];
  attachmentIds: string[];
}

export function buildComposerSendPayload(input: {
  userId: string;
  text: string;
  attachments?: ComposerAttachment[];
}): ComposerSendPayload {
  const attachments = input.attachments ?? [];
  return {
    userId: input.userId,
    text: input.text,
    imageIds: attachments
      .filter((item) => item.kind === "image" || item.kind === "animated_image")
      .map((item) => item.fileId),
    attachmentIds: attachments.map((item) => item.fileId)
  };
}

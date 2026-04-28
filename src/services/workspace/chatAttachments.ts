import type { ChatAttachment, ChatAttachmentSemanticKind } from "#types/chatContracts.ts";

type ChatAttachmentLike = Pick<ChatAttachment, "fileId"> & {
  kind: string;
  semanticKind?: ChatAttachmentSemanticKind | undefined;
};

export function isPendingChatAttachmentId(fileId: string): boolean {
  return String(fileId ?? "").trim().startsWith("pending:");
}

export function isResolvedChatAttachment(attachment: Pick<ChatAttachment, "fileId">): boolean {
  const fileId = String(attachment.fileId ?? "").trim();
  return fileId.length > 0 && !isPendingChatAttachmentId(fileId);
}

export function dedupeResolvedChatAttachments<T extends Pick<ChatAttachment, "fileId">>(attachments: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const attachment of attachments) {
    if (!isResolvedChatAttachment(attachment)) {
      continue;
    }
    const fileId = attachment.fileId.trim();
    if (seen.has(fileId)) {
      continue;
    }
    seen.add(fileId);
    deduped.push(attachment);
  }
  return deduped;
}

export function getVisualAttachmentSemanticKind(
  attachment: ChatAttachmentLike
): ChatAttachmentSemanticKind | null {
  if (!isResolvedChatAttachment(attachment)) {
    return null;
  }
  if (attachment.kind !== "image" && attachment.kind !== "animated_image") {
    return null;
  }
  return attachment.semanticKind === "emoji" ? "emoji" : "image";
}

export function collectVisualAttachmentFileIds(
  attachments: readonly ChatAttachmentLike[] | undefined,
  semanticKind: ChatAttachmentSemanticKind
): string[] {
  return dedupeResolvedChatAttachments([...(attachments ?? [])])
    .filter((attachment) => getVisualAttachmentSemanticKind(attachment) === semanticKind)
    .map((attachment) => attachment.fileId);
}

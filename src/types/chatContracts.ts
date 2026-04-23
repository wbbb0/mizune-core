import { z } from "zod";

export const chatFileKindValues = ["image", "animated_image", "video", "audio", "file"] as const;
export const chatAttachmentSourceValues = ["chat_message", "web_upload", "browser", "chat_file"] as const;
export const chatAttachmentSemanticKindValues = ["image", "emoji"] as const;

export const chatAttachmentSchema = z.object({
  fileId: z.string(),
  kind: z.enum(chatFileKindValues),
  source: z.enum(chatAttachmentSourceValues),
  sourceName: z.string().nullable(),
  mimeType: z.string().nullable(),
  semanticKind: z.enum(chatAttachmentSemanticKindValues).optional()
});

export type ChatFileKind = (typeof chatFileKindValues)[number];
export type ChatAttachmentSource = (typeof chatAttachmentSourceValues)[number];
export type ChatAttachmentSemanticKind = (typeof chatAttachmentSemanticKindValues)[number];
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

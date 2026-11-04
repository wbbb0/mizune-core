/** Local media plus display intent; wire encoding belongs to the destination connector. */
export interface MediaDeliveryInput {
  filePath: string;
  kind: "image" | "emoji" | "audio" | "file";
  name?: string | null;
  /** Optional native QQ sticker identity. Other platforms send the local bitmap. */
  nativeEmoji?: { id: string; packageId: number; key: string; summary?: string };
}

import { readFile } from "node:fs/promises";
import type { MediaDeliveryInput } from "#services/messaging/mediaDeliveryInput.ts";
import type { OneBotMessageSegment } from "./types.ts";

/** Encode the platform-neutral media request only after OneBot has been selected. */
export async function encodeOneBotMedia(input: MediaDeliveryInput): Promise<OneBotMessageSegment[]> {
  if (input.kind === "emoji" && input.nativeEmoji) {
    const sticker = input.nativeEmoji;
    if (!sticker.id.trim() || !sticker.key.trim() || !Number.isSafeInteger(sticker.packageId) || sticker.packageId <= 0) {
      throw new Error("原生表情标识无效。");
    }
    return [{ type: "mface", data: { emoji_id: sticker.id, emoji_package_id: sticker.packageId,
      key: sticker.key, summary: sticker.summary ?? "[表情]" } }];
  }
  return [{ type: input.kind === "audio" ? "record" : "image", data: {
    file: `base64://${(await readFile(input.filePath)).toString("base64")}`,
    ...(input.kind === "emoji" ? { sub_type: 1, summary: "[表情]" } : {})
  } }];
}

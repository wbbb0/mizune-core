import { QqDeliveryError, type QqMediaInput } from "./types.ts";

export const QQ_SMALL_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_BYTES = new Map([[1, 20 * 1024 * 1024], [2, 30 * 1024 * 1024], [3, 20 * 1024 * 1024], [4, 200 * 1024 * 1024]]);

/** Preflight rejects invalid representations; encoding/conversion belongs to the caller's media adapter. */
export function validateQqMedia(input: QqMediaInput): void {
  const limit = MAX_BYTES.get(input.fileType);
  if (!limit) throw new QqDeliveryError("rejected", "invalid_media_type", undefined, "upload");
  if ((input.url == null) === (input.bytes == null)) throw new QqDeliveryError("rejected", "media_source_required", undefined, "upload");
  if (input.url != null) {
    let url: URL;
    try { url = new URL(input.url); } catch { throw new QqDeliveryError("rejected", "invalid_media_url", undefined, "upload"); }
    if (input.url.length > 8192 || !/^https?:$/.test(url.protocol) || url.username || url.password)
      throw new QqDeliveryError("rejected", "invalid_media_url", undefined, "upload");
    return;
  }
  const bytes = input.bytes!;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit)
    throw new QqDeliveryError("rejected", "media_size_limit", undefined, "upload");
  if (!input.name || Buffer.byteLength(input.name) > 255 || input.name.includes("\0"))
    throw new QqDeliveryError("rejected", "media_name_required", undefined, "upload");
  if (input.fileType === 1) {
    const signature = bytes.subarray(0, 12);
    const recognized = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || (signature[0] === 255 && signature[1] === 216 && signature[2] === 255)
      || ["GIF87a", "GIF89a"].includes(signature.subarray(0, 6).toString("ascii"))
      || (signature.subarray(0, 4).toString("ascii") === "RIFF" && signature.subarray(8, 12).toString("ascii") === "WEBP")
      || signature.subarray(0, 2).toString("ascii") === "BM";
    if (!recognized) throw new QqDeliveryError("rejected", "invalid_image_format", undefined, "upload");
  }
}

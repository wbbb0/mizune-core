import { validateQqMedia, QQ_SMALL_IMAGE_UPLOAD_BYTES } from "./mediaValidation.ts";
import { createHash } from "node:crypto";
import type { QqHttpClient } from "./httpClient.ts";
import { qqTargetPath } from "./replyPermit.ts";
import { QqDeliveryError, type QqMediaInput, type QqReplyPermit } from "./types.ts";

function hash(algorithm: "md5" | "sha1", bytes: Buffer): string { return createHash(algorithm).update(bytes).digest("hex"); }

/** Upload never sends a message. The caller must submit its file_info through the reply budget. */
export async function uploadQqMedia(http: QqHttpClient, permit: QqReplyPermit, input: QqMediaInput, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  validateQqMedia(input);
  const path = qqTargetPath(permit);
  let payload: Record<string, unknown>;
  if (input.url) {
    const url = new URL(input.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new QqDeliveryError("rejected", "invalid_media_url");
    payload = { file_type: input.fileType, url: url.toString(), srv_send_msg: false };
  } else {
    const bytes = input.bytes!;
    if (!bytes.length || bytes.length > 200 * 1024 * 1024) throw new QqDeliveryError("rejected", "media_size_limit");
    if (!input.name) throw new QqDeliveryError("rejected", "media_name_required");
    if (input.fileType === 1 && bytes.length <= QQ_SMALL_IMAGE_UPLOAD_BYTES) {
      // Match the official SDK's small-image wire format: raw base64, never a data URL or OneBot prefix.
      const uploaded = await http.request<{ file_info: string }>("POST", `${path}/files`, {
        file_type: input.fileType, file_data: bytes.toString("base64"), srv_send_msg: false
      }, signal);
      if (typeof uploaded.file_info !== "string" || !uploaded.file_info) throw new QqDeliveryError("unknown", "invalid_file_info", undefined, "upload");
      return uploaded.file_info;
    }
    // Larger images and other local media use the documented split upload path.
    const prepared = await http.request<{
      upload_id: string; block_size: string;
      parts: Array<{ index: number; presigned_url: string; block_size: string }>;
    }>("POST", `${path}/upload_prepare`, {
      file_type: input.fileType, file_name: input.name, file_size: String(bytes.length),
      md5: hash("md5", bytes), sha1: hash("sha1", bytes), md5_10m: hash("md5", bytes.subarray(0, 10_002_432))
    }, signal);
    if (!prepared.upload_id || !Array.isArray(prepared.parts) || !prepared.parts.length) throw new QqDeliveryError("unknown", "invalid_upload_plan");
    let offset = 0;
    for (let index = 0; index < prepared.parts.length; index += 1) {
      signal?.throwIfAborted();
      const part = prepared.parts[index]!;
      const size = Number(part.block_size || prepared.block_size);
      if (part.index !== index || !Number.isSafeInteger(size) || size <= 0 || offset >= bytes.length) {
        throw new QqDeliveryError("unknown", "invalid_upload_part");
      }
      const chunk = bytes.subarray(offset, Math.min(offset + size, bytes.length));
      await http.putPart(part.presigned_url, chunk, signal);
      await http.request("POST", `${path}/upload_part_finish`, {
        upload_id: prepared.upload_id, part_index: part.index, block_size: String(chunk.length), md5: hash("md5", chunk)
      }, signal);
      offset += chunk.length;
    }
    if (offset !== bytes.length) throw new QqDeliveryError("unknown", "incomplete_upload_plan");
    payload = { file_type: input.fileType, file_name: input.name, upload_id: prepared.upload_id, srv_send_msg: false };
  }
  signal?.throwIfAborted();
  const response = await http.request<{ file_info: string }>("POST", `${path}/files`, payload, signal);
  if (typeof response.file_info !== "string" || !response.file_info) throw new QqDeliveryError("unknown", "invalid_file_info");
  return response.file_info;
}

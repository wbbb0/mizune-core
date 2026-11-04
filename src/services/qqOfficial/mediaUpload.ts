import { createHash } from "node:crypto";
import type { QqHttpClient } from "./httpClient.ts";
import { qqTargetPath, type QqReplyPermitRegistry } from "./replyPermit.ts";
import { QqDeliveryError, type QqMediaInput, type QqReplyPermit } from "./types.ts";

function hash(algorithm: "md5" | "sha1", bytes: Buffer): string { return createHash(algorithm).update(bytes).digest("hex"); }

/** Upload never sends a message. The caller must submit its file_info through the reply budget. */
export async function uploadQqMedia(http: QqHttpClient, registry: QqReplyPermitRegistry,
  permit: QqReplyPermit, input: QqMediaInput, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  registry.assert(permit);
  if ((input.url == null) === (input.bytes == null)) throw new QqDeliveryError("rejected", "media_source_required");
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
    // Use the documented split upload for all local assets; file_data encoding is underspecified.
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
      registry.assert(permit);
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
  registry.assert(permit);
  const response = await http.request<{ file_info: string }>("POST", `${path}/files`, payload, signal);
  if (typeof response.file_info !== "string" || !response.file_info) throw new QqDeliveryError("unknown", "invalid_file_info");
  return response.file_info;
}

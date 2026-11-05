import type { fetchWithProxy } from "#services/proxy/index.ts";

/** Consume once, bound allocation before JSON/base64 decoding, and cancel on every failed read. */
export async function readBoundedProviderBody(response: Awaited<ReturnType<typeof fetchWithProxy>>, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("接口响应大小上限无效");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("接口响应超过大小限制");
  }
  if (!response.body) throw new Error("接口响应为空");
  const reader = response.body.getReader();
  let completed = false;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) { completed = true; break; }
      length += value.byteLength;
      if (length > limit) throw new Error("接口响应超过大小限制");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

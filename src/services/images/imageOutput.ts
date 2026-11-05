export function decodeImageBase64(value: string, maxBytes: number): Buffer {
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("图像接口返回无效的 Base64 图片或超过大小限制");
  }
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length || buffer.length > maxBytes) throw new Error("生成图片为空或超过资产大小限制");
  return buffer;
}

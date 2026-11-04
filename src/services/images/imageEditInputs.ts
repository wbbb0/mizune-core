import { Blob } from "node:buffer";
import { FormData } from "undici";
import sharp from "sharp";

export interface ImageEditSource {
  buffer: Buffer;
}

/** Upload local asset bytes; never turn an arbitrary model-supplied URL into an authenticated request. */
export async function buildImageEditBody(input: {
  model: string;
  prompt: string;
  settings: Record<string, unknown>;
  images: ImageEditSource[];
  mask?: ImageEditSource;
  maxBytes: number;
}): Promise<FormData> {
  if (input.images.length < 1 || input.images.length > 16) throw new Error("参考图数量必须在 1 到 16 张之间");
  const sources = [...input.images, ...(input.mask ? [input.mask] : [])];
  if (sources.some(source => !source.buffer.length || source.buffer.length > input.maxBytes)
    || sources.reduce((total, source) => total + source.buffer.length, 0) > input.maxBytes) {
    throw new Error("参考图及蒙版总大小超过资产上传限制，或图片为空");
  }
  const metadata = await Promise.all(sources.map(async source => {
    const info = await sharp(source.buffer).metadata();
    if (!info.width || !info.height || !info.format || !["png", "jpeg", "webp"].includes(info.format)
      || (info.pages ?? 1) > 1) throw new Error("参考图必须是静态 PNG、JPEG 或 WebP 图片");
    return info;
  }));
  if (input.mask) {
    const first = metadata[0]!;
    const mask = metadata.at(-1)!;
    if (mask.format !== "png" || !mask.hasAlpha || mask.width !== first.width || mask.height !== first.height) {
      throw new Error("蒙版必须是带透明通道且与第一张参考图尺寸相同的 PNG 图片");
    }
    const alpha = (await sharp(input.mask.buffer).extractChannel("alpha").stats()).channels[0];
    if (!alpha || alpha.min === 255) throw new Error("蒙版需要包含透明区域");
  }
  const body = new FormData();
  body.set("model", input.model);
  body.set("prompt", input.prompt);
  body.set("n", "1");
  for (const [key, value] of Object.entries(input.settings)) {
    if (value !== undefined) body.set(key, String(value));
  }
  input.images.forEach((source, index) => {
    const format = metadata[index]!.format!;
    body.append("image[]", new Blob([new Uint8Array(source.buffer)], { type: `image/${format}` }), `reference-${index + 1}.${format}`);
  });
  if (input.mask) body.set("mask", new Blob([new Uint8Array(input.mask.buffer)], { type: "image/png" }), "mask.png");
  return body;
}

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import sharp from "sharp";
import type { ChatFileRecord } from "#services/workspace/types.ts";
import type { ToolDescriptor, ToolHandler, BuiltinToolContext } from "../core/shared.ts";
import { buildChatFileHandleResultFromContext } from "../core/fileHandle.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { chatFileListPolicy } from "../core/resultObservationPresets.ts";

type ImageFormat = "png" | "jpeg" | "webp";
type ResizeMode = "stretch" | "fit" | "cover" | "inside" | "outside";
type FlipMode = "horizontal" | "vertical" | "both";

const MAX_IMAGE_TRANSFORM_DIMENSION = 8192;
const MAX_IMAGE_TRANSFORM_PIXELS = 40_000_000;

interface ImageSource {
  buffer: Buffer;
  sourceName: string;
  sourceType: "asset" | "path";
  sourceRef: string;
  sourceMimeType: string | null;
  sourceFile?: ChatFileRecord;
}

interface CropInput {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ResizeInput {
  width?: number;
  height?: number;
  mode: ResizeMode;
}

interface TransformSummary {
  crop: CropInput | null;
  rotate_degrees: number;
  flip: FlipMode | null;
  resize: ResizeInput | null;
  format: ImageFormat;
  quality: number | null;
}

export const imageTransformToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "asset_image_transform",
        description: "对图片做本地确定性处理并输出新 asset：裁剪、水平/垂直翻转、旋转、格式转换、拉伸或修改分辨率。asset_ref 与 path 二选一；未传 resize 时保持原图或裁剪后的分辨率。",
        parameters: {
          type: "object",
          properties: {
            asset_ref: { type: "string", description: "输入图片 asset 引用。与 path 二选一。" },
            asset_id: { type: "string", description: "输入图片 asset ID。与 asset_ref/path 二选一。" },
            path: { type: "string", description: "输入本地图片路径。与 asset_ref/asset_id 二选一。" },
            crop: {
              type: "object",
              properties: {
                left: { type: "integer", minimum: 0 },
                top: { type: "integer", minimum: 0 },
                width: { type: "integer", minimum: 1, maximum: MAX_IMAGE_TRANSFORM_DIMENSION },
                height: { type: "integer", minimum: 1, maximum: MAX_IMAGE_TRANSFORM_DIMENSION }
              },
              required: ["left", "top", "width", "height"],
              additionalProperties: false
            },
            rotate_degrees: { type: "integer", enum: [-270, -180, -90, 0, 90, 180, 270], description: "手动旋转角度。工具实际顺序为：自动按 EXIF 方向校正、裁剪、翻转、旋转、resize。" },
            flip: { type: "string", enum: ["horizontal", "vertical", "both"] },
            resize: {
              type: "object",
              properties: {
                width: { type: "integer", minimum: 1, maximum: MAX_IMAGE_TRANSFORM_DIMENSION },
                height: { type: "integer", minimum: 1, maximum: MAX_IMAGE_TRANSFORM_DIMENSION },
                mode: {
                  type: "string",
                  enum: ["stretch", "fit", "cover", "inside", "outside"],
                  description: "stretch 会强制拉伸到 width/height；fit 等比适配；cover 等比裁切填满。默认：同时给宽高时 stretch，只给一边时 fit。"
                }
              },
              additionalProperties: false
            },
            format: { type: "string", enum: ["png", "jpeg", "jpg", "webp"], description: "输出格式；默认沿用原图支持的格式，否则 png。" },
            quality: { type: "integer", minimum: 1, maximum: 100, description: "jpeg/webp 输出质量。" },
            output_name: { type: "string", description: "可选输出文件名；扩展名会按输出格式修正。" }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: (config) => config.chatFiles.enabled,
    resultObservation: chatFileListPolicy()
  }
];

export const imageTransformToolHandlers: Record<string, ToolHandler> = {
  async asset_image_transform(_toolCall, args, context) {
    try {
      const source = await resolveImageSource(context, args);
      const crop = parseCrop(args);
      const resize = parseResize(args);
      const rotateDegrees = normalizeRotateDegrees(getNumberArg(args, "rotate_degrees") ?? 0);
      const flip = parseFlip(getStringArg(args, "flip"));
      const format = parseFormat(getStringArg(args, "format"), source.sourceMimeType);
      const quality = parseQuality(getNumberArg(args, "quality"));
      const transformed = await transformImage(source.buffer, {
        crop,
        resize,
        rotate_degrees: rotateDegrees,
        flip,
        format,
        quality
      });
      const outputName = getStringArg(args, "output_name");
      const sourceName = buildOutputName(outputName || source.sourceName, format, !outputName);
      const stored = await context.chatFileStore.importBuffer({
        buffer: transformed.buffer,
        sourceName,
        mimeType: mimeTypeFromFormat(format),
        kind: "image",
        origin: "image_transform",
        sourceContext: {
          tool: "asset_image_transform",
          source_type: source.sourceType,
          source_ref: source.sourceRef,
          operations: JSON.stringify(transformed.operations)
        }
      });
      const file = buildChatFileHandleResultFromContext(stored, context);
      return JSON.stringify({
        ok: true,
        asset_ref: stored.fileRef,
        file_id: stored.fileId,
        source: {
          type: source.sourceType,
          ref: source.sourceRef
        },
        output: {
          width: transformed.width,
          height: transformed.height,
          format,
          mime_type: stored.mimeType,
          size_bytes: stored.sizeBytes
        },
        file,
        asset_handle: file.asset_handle,
        next_actions: file.next_actions ?? []
      });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
};

async function resolveImageSource(context: BuiltinToolContext, args: unknown): Promise<ImageSource> {
  const assetSelector = getStringArg(args, "asset_ref") || getStringArg(args, "asset_id");
  const path = getStringArg(args, "path");
  if (assetSelector && path) {
      throw new Error("asset_ref/asset_id and path are mutually exclusive");
  }
  if (getStringArg(args, "asset_ref") && getStringArg(args, "asset_id")) {
    throw new Error("asset_ref and asset_id are mutually exclusive");
  }
  if (!assetSelector && !path) {
    throw new Error("asset_ref, asset_id, or path is required");
  }

  if (assetSelector) {
    const file = await resolveChatFile(context, assetSelector);
    if (!file) {
      throw new Error(await buildUnknownAssetError(context, assetSelector));
    }
    if (file.kind !== "image") {
      throw new Error("asset_image_transform only supports static image assets");
    }
    const absolutePath = await context.chatFileStore.resolveAbsolutePath(file.fileId);
    return {
      buffer: await readFile(absolutePath),
      sourceName: file.sourceName,
      sourceType: "asset",
      sourceRef: file.fileRef,
      sourceMimeType: file.mimeType,
      sourceFile: file
    };
  }

  const resolved = context.localFileService.resolvePath(path);
  const fileStat = await stat(resolved.absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("path must point to an image file");
  }
  return {
    buffer: await readFile(resolved.absolutePath),
    sourceName: basename(resolved.absolutePath),
    sourceType: "path",
    sourceRef: resolved.relativePath,
    sourceMimeType: mimeTypeFromFileName(resolved.absolutePath)
  };
}

async function transformImage(buffer: Buffer, options: TransformSummary): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
  operations: TransformSummary;
}> {
  const metadata = await sharp(buffer, { failOn: "none", limitInputPixels: MAX_IMAGE_TRANSFORM_PIXELS }).metadata();
  assertAllowedOutputDimensions(estimateOutputDimensions(metadata, options));

  let pipeline = sharp(buffer, { failOn: "none", limitInputPixels: MAX_IMAGE_TRANSFORM_PIXELS }).rotate();
  if (options.crop) {
    pipeline = pipeline.extract(options.crop);
  }
  if (options.flip === "horizontal" || options.flip === "both") {
    pipeline = pipeline.flop();
  }
  if (options.flip === "vertical" || options.flip === "both") {
    pipeline = pipeline.flip();
  }
  if (options.rotate_degrees !== 0) {
    pipeline = pipeline.rotate(options.rotate_degrees);
  }
  if (options.resize) {
    pipeline = pipeline.resize({
      ...(options.resize.width != null ? { width: options.resize.width } : {}),
      ...(options.resize.height != null ? { height: options.resize.height } : {}),
      fit: sharpFitFromResizeMode(options.resize.mode)
    });
  }
  pipeline = applyOutputFormat(pipeline, options.format, options.quality);
  const result = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: result.data,
    width: result.info.width,
    height: result.info.height,
    operations: options
  };
}

function parseCrop(args: unknown): CropInput | null {
  const value = objectArg(args, "crop");
  if (!value) return null;
  return {
    left: positiveInteger(value.left, "crop.left", { allowZero: true }),
    top: positiveInteger(value.top, "crop.top", { allowZero: true }),
    width: positiveInteger(value.width, "crop.width", { max: MAX_IMAGE_TRANSFORM_DIMENSION }),
    height: positiveInteger(value.height, "crop.height", { max: MAX_IMAGE_TRANSFORM_DIMENSION })
  };
}

function parseResize(args: unknown): ResizeInput | null {
  const value = objectArg(args, "resize");
  if (!value) return null;
  const width = value.width == null ? undefined : positiveInteger(value.width, "resize.width", { max: MAX_IMAGE_TRANSFORM_DIMENSION });
  const height = value.height == null ? undefined : positiveInteger(value.height, "resize.height", { max: MAX_IMAGE_TRANSFORM_DIMENSION });
  if (width == null && height == null) {
    throw new Error("resize.width or resize.height is required");
  }
  const requestedMode = typeof value.mode === "string" ? value.mode.trim() : "";
  const mode = parseResizeMode(requestedMode, width != null && height != null ? "stretch" : "fit");
  if (mode === "stretch" && (width == null || height == null)) {
    throw new Error("resize.mode=stretch requires both resize.width and resize.height");
  }
  return {
    ...(width != null ? { width } : {}),
    ...(height != null ? { height } : {}),
    mode
  };
}

function parseResizeMode(value: string, fallback: ResizeMode): ResizeMode {
  if (value === "stretch" || value === "fit" || value === "cover" || value === "inside" || value === "outside") {
    return value;
  }
  if (!value) return fallback;
  throw new Error("resize.mode must be one of stretch, fit, cover, inside, outside");
}

function sharpFitFromResizeMode(mode: ResizeMode): keyof sharp.FitEnum {
  if (mode === "stretch") return "fill";
  if (mode === "fit") return "contain";
  return mode;
}

function parseFlip(value: string): FlipMode | null {
  if (!value) return null;
  if (value === "horizontal" || value === "vertical" || value === "both") {
    return value;
  }
  throw new Error("flip must be one of horizontal, vertical, both");
}

function normalizeRotateDegrees(value: number): number {
  if (!Number.isInteger(value) || ![-270, -180, -90, 0, 90, 180, 270].includes(value)) {
    throw new Error("rotate_degrees must be one of -270, -180, -90, 0, 90, 180, 270");
  }
  const normalized = ((value % 360) + 360) % 360;
  return normalized === 270 ? -90 : normalized;
}

function parseQuality(value: number | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("quality must be an integer from 1 to 100");
  }
  return value;
}

function parseFormat(value: string, sourceMimeType: string | null): ImageFormat {
  if (value === "jpg") return "jpeg";
  if (value === "png" || value === "jpeg" || value === "webp") {
    return value;
  }
  if (sourceMimeType === "image/jpeg") return "jpeg";
  if (sourceMimeType === "image/webp") return "webp";
  return "png";
}

function applyOutputFormat(pipeline: sharp.Sharp, format: ImageFormat, quality: number | null): sharp.Sharp {
  if (format === "jpeg") {
    return pipeline.jpeg(quality != null ? { quality } : {});
  }
  if (format === "webp") {
    return pipeline.webp(quality != null ? { quality } : {});
  }
  return pipeline.png();
}

function mimeTypeFromFormat(format: ImageFormat): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function mimeTypeFromFileName(fileName: string): string | null {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".png") return "image/png";
  return null;
}

function buildOutputName(sourceName: string, format: ImageFormat, appendSuffix: boolean): string {
  const normalized = String(sourceName ?? "").trim() || "image";
  const ext = extensionFromFormat(format);
  const currentExt = extname(normalized);
  const base = (currentExt ? normalized.slice(0, -currentExt.length) : normalized).trim() || "image";
  return `${base}${appendSuffix ? "_transformed" : ""}${ext}`;
}

function extensionFromFormat(format: ImageFormat): string {
  if (format === "jpeg") return ".jpg";
  if (format === "webp") return ".webp";
  return ".png";
}

function objectArg(args: unknown, key: string): Record<string, unknown> | null {
  if (typeof args !== "object" || !args || !(key in args)) {
    return null;
  }
  const value = (args as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown, fieldName: string, options: { allowZero?: boolean; max?: number } = {}): number {
  const parsed = Number(value);
  const min = options.allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${fieldName} must be an integer >= ${min}`);
  }
  if (options.max != null && parsed > options.max) {
    throw new Error(`${fieldName} must be <= ${options.max}`);
  }
  return parsed;
}

function estimateOutputDimensions(metadata: sharp.Metadata, options: TransformSummary): { width: number; height: number } {
  let width = options.crop?.width ?? metadata.width ?? 0;
  let height = options.crop?.height ?? metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("input image dimensions could not be determined");
  }

  if (Math.abs(options.rotate_degrees) === 90 || Math.abs(options.rotate_degrees) === 270) {
    [width, height] = [height, width];
  }

  const resize = options.resize;
  if (!resize) {
    return { width, height };
  }
  if (resize.mode === "stretch" || resize.mode === "cover" || resize.mode === "fit") {
    return {
      width: resize.width ?? width,
      height: resize.height ?? height
    };
  }

  if (resize.width != null && resize.height != null) {
    const scale = resize.mode === "inside"
      ? Math.min(resize.width / width, resize.height / height)
      : Math.max(resize.width / width, resize.height / height);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }
  if (resize.width != null) {
    return {
      width: resize.width,
      height: Math.max(1, Math.round(height * (resize.width / width)))
    };
  }
  if (resize.height != null) {
    return {
      width: Math.max(1, Math.round(width * (resize.height / height))),
      height: resize.height
    };
  }
  return { width, height };
}

function assertAllowedOutputDimensions(dimensions: { width: number; height: number }): void {
  if (
    dimensions.width > MAX_IMAGE_TRANSFORM_DIMENSION
    || dimensions.height > MAX_IMAGE_TRANSFORM_DIMENSION
    || dimensions.width * dimensions.height > MAX_IMAGE_TRANSFORM_PIXELS
  ) {
    // TODO: Add safe automatic downsampling for oversized outputs by adjusting
    // the resize target before sharp.toBuffer(), while keeping crop coordinates
    // based on the original image dimensions.
    throw new Error(
      `image transform output is too large: ${dimensions.width}x${dimensions.height}; `
      + `max dimension is ${MAX_IMAGE_TRANSFORM_DIMENSION}, max pixels is ${MAX_IMAGE_TRANSFORM_PIXELS}`
    );
  }
}

async function resolveChatFile(context: BuiltinToolContext, fileSelector: string): Promise<ChatFileRecord | null> {
  const normalized = String(fileSelector ?? "").trim();
  if (!normalized) {
    return null;
  }
  const direct = await context.chatFileStore.getFile(normalized);
  if (direct) {
    return direct;
  }
  const files = await context.chatFileStore.listFiles().catch(() => []);
  return files.find((item) => (
    item.fileRef === normalized
    || item.sourceName === normalized
    || item.chatFilePath.split("/").at(-1) === normalized
  )) ?? null;
}

async function buildUnknownAssetError(context: BuiltinToolContext, requestedAssetRef: string): Promise<string> {
  const normalized = String(requestedAssetRef ?? "").trim();
  if (!normalized) {
    return "unknown asset";
  }
  const files = await context.chatFileStore.listFiles().catch(() => []);
  const matched = files.find((item) => (
    item.fileRef === normalized
    || item.fileId === normalized
    || item.sourceName === normalized
    || item.chatFilePath.split("/").at(-1) === normalized
  ));
  if (matched) {
    return `unknown asset: ${normalized}; use asset_ref=${matched.fileRef} or asset_id=${matched.fileId}`;
  }
  return `unknown asset: ${normalized}`;
}

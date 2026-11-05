import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

/** 有界的单次转码。使用完整 MP4 索引，临时目录仅本用户可读并在结束时清理。 */
export async function encodeAnimatedVideo(buffer: Buffer, maxBytes: number, maxPixels: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const metadata = await sharp(buffer, { animated: true }).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.pageHeight ?? metadata.height ?? 1;
  const framePixels = Math.min(maxPixels, 512 * 512);
  const scale = Math.min(1, Math.sqrt(framePixels / (width * height)));
  const gif = await sharp(buffer, { animated: true })
    .resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), fit: "inside" })
    .gif().toBuffer();
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "llm-animated-video-"));
  try {
    const output = join(directory, "animation.mp4");
    await encodeToFile(gif, output, maxBytes, signal);
    const info = await stat(output);
    if (!info.size || info.size > maxBytes) throw new Error("动图视频为空或超过资产大小限制");
    signal?.throwIfAborted();
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function encodeToFile(gif: Buffer, output: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-threads", "1", "-ignore_loop", "1", "-i", "pipe:0",
      "-an", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-threads", "1",
      "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-fps_mode", "vfr",
      // 留出容器尾部空间；触发截断的文件一定超过 maxBytes，由调用方拒绝。
      "-fs", String(maxBytes + 65536), "-movflags", "+faststart", "-f", "mp4", output
    ], { stdio: ["pipe", "ignore", "ignore"] });
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(new Error("动图视频转码已取消"));
    const timer = setTimeout(() => stop(new Error("动图视频转码超时")), 30000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", () => { failure ??= new Error("无法启动 ffmpeg 动图视频转码"); });
    child.stdin.on("error", () => { failure ??= new Error("动图视频转码输入失败"); });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new Error("动图视频转码失败"));
      else resolve();
    });
    child.stdin.end(gif);
  });
}

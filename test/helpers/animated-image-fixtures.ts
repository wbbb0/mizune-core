import sharp from "sharp";

export async function createAnimatedGif(): Promise<Buffer> {
  const frames = await Promise.all(["red", "blue"].map(background =>
    sharp({ create: { width: 8, height: 6, channels: 3, background } }).png().toBuffer()));
  return sharp(frames, { join: { animated: true } }).gif({ delay: [100, 300], loop: 0 }).toBuffer();
}

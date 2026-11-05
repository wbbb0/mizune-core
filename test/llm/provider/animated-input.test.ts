import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import pino from "pino";
import { createAnimatedGif } from "../../helpers/animated-image-fixtures.ts";
import { createLlmTestConfig, createSseResponse, withMockFetch } from "../../helpers/llm-test-support.tsx";
import { withTempDir } from "../../helpers/config-test-support.tsx";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createVisualInputProjector } from "../../../src/llm/provider/visualInputProjection.ts";
import { MediaVisionService } from "../../../src/services/workspace/mediaVisionService.ts";
import { getLlmProvider } from "../../../src/llm/provider/providerRegistry.ts";
import { setFetchImplementationForTests } from "../../../src/services/proxy/index.ts";
import { parseDiscoveredModels } from "../../../src/llm/provider/modelDiscoveryMetadata.ts";
import type { LlmMessage, LlmProviderRequestContext } from "../../../src/llm/provider/providerTypes.ts";
import type { LlmProviderType } from "../../../src/config/llmProviderDefinitions.ts";

const logger = pino({ level: "silent" });
const gif = await createAnimatedGif();
const gifUrl = `data:image/gif;base64,${gif.toString("base64")}`;
const messages: LlmMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url: gifUrl } }] }];
const runFile = promisify(execFile);
const ffmpegAvailable = await runFile("ffmpeg", ["-version"]).then(() => true, () => false);
afterEach(() => setFetchImplementationForTests(null));

function context(type: LlmProviderType = "openai_compatible", video = true): LlmProviderRequestContext {
  const config = createLlmTestConfig({ chat: { capabilities: { supportsVision: true, supportsVideoInput: video } } });
  config.llm.providers.test!.type = type;
  return { config, logger, modelRef: "main", model: "test-model", modelProfile: config.llm.models.main!, providerName: "test", providerConfig: config.llm.providers.test!, baseUrl: "https://test.example/v1", candidateIndex: 0 };
}

test("媒体预处理在安全检查后保留原始动画，模型请求前才选择表现形式", async () => {
  await withTempDir("animated-input", async dir => {
    const path = join(dir, "test.gif");
    await writeFile(path, gif);
    const ctx = context();
    let guarded = false;
    const vision = new MediaVisionService(ctx.config, logger, {
      async getFile() { assert.equal(guarded, true); return { fileId: "gif", kind: "animated_image" } as any; },
      async resolveAbsolutePath() { return path; }
    }, { async guardChatFileForLlm() { guarded = true; return "allow"; } });
    const visual = await vision.prepareFileForModel("gif");
    assert.equal(visual.inputUrl, gifUrl);
    assert.equal(visual.animated, true);
    assert.equal(visual.durationMs, 400);
    assert.equal(visual.sampledFrameCount, null);
  });
});

test("无视频能力或不支持的视频协议都收到有界拼图，原消息保持完整动画", async () => {
  for (const [type, video] of [["openai_compatible", false], ["openai", true], ["anthropic", true], ["lmstudio", true]] as const) {
    const ctx = context(type, video);
    ctx.config.conversation.images.maxSerializedPixels = 24;
    const projected = await createVisualInputProjector(ctx.config)(messages, ctx);
    const part = (projected[0]!.content as any[])[0];
    assert.equal(part.type, "image_url");
    assert.match(part.image_url.url, /^data:image\/png;base64,/);
    const metadata = await sharp(Buffer.from(part.image_url.url.split(",")[1], "base64")).metadata();
    assert.ok(metadata.width! * metadata.height! <= 24);
  }
  assert.equal((messages[0]!.content as any[])[0].image_url.url, gifUrl);
});

test("DashScope 过短动图在请求前使用拼图", async () => {
  const ctx = context("dashscope");
  const longTwoFrames = await sharp(gif, { animated: true }).gif({ delay: [2000, 2000] }).toBuffer();
  for (const source of [gif, longTwoFrames]) {
    const input: LlmMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/gif;base64,${source.toString("base64")}` } }] }];
    const projected = await createVisualInputProjector(ctx.config)(input, ctx);
    assert.equal((projected[0]!.content as any[])[0].type, "image_url");
    assert.match((projected[0]!.content as any[])[0].image_url.url, /^data:image\/png;base64,/);
  }
});

test("原生视频保留两帧、单帧尺寸及不等帧时长", { skip: !ffmpegAvailable }, async () => {
  const ctx = context();
  const projected = await createVisualInputProjector(ctx.config)(messages, ctx);
  const part = (projected[0]!.content as any[])[0];
  assert.equal(part.type, "video_url");
  assert.equal(part.durationMs, 400);
  assert.equal(part.fps, 10);
  assert.match(part.video_url.url, /^data:video\/mp4;base64,/);
  const video = Buffer.from(part.video_url.url.split(",")[1], "base64");
  const movieHeader = video.indexOf("mvhd");
  assert.ok(movieHeader > 0);
  assert.equal(video[movieHeader + 4], 0);
  assert.ok(video.readUInt32BE(movieHeader + 20) > 0, "MP4 头部必须提供非零时长，不能只依赖片段推断");
  await withTempDir("animated-video-probe", async dir => {
    const path = join(dir, "test.mp4");
    await writeFile(path, video);
    const probe = JSON.parse((await runFile("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames,duration", "-of", "json", path], { encoding: "utf8" })).stdout);
    assert.equal(probe.streams[0].width, 8);
    assert.equal(probe.streams[0].height, 6);
    assert.equal(Number(probe.streams[0].nb_read_frames), 2);
    assert.ok(Number(probe.streams[0].duration) >= 0.39, JSON.stringify(probe));
    assert.ok(Number(probe.streams[0].duration) <= 0.5, JSON.stringify(probe));
  });
});

test("转码失败使用拼图，取消请求不会降级后继续调用", async () => {
  const ctx = context();
  ctx.config.chatFiles.maxUploadBytes = 1;
  const projected = await createVisualInputProjector(ctx.config)(messages, ctx);
  assert.equal((projected[0]!.content as any[])[0].type, "image_url");
  await assert.rejects(createVisualInputProjector(ctx.config)(messages, ctx, AbortSignal.abort()), /abort/i);
});

for (const type of ["google", "vertex", "vertex_express", "dashscope", "openrouter", "openai_compatible"] as const) {
  test(`${type} 将视频内容映射到自己的协议且不泄漏内部元信息`, async () => {
    const ctx = context(type);
    setFetchImplementationForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const content = type === "dashscope" ? body.input.messages[0].content
        : type === "google" || type === "vertex" || type === "vertex_express" ? body.contents[0].parts : body.messages[0].content;
      if (type === "dashscope") assert.deepEqual(content, [{ video: "data:video/mp4;base64,AQID", fps: 10 }]);
      else if (["google", "vertex", "vertex_express"].includes(type)) assert.deepEqual(content, [{ inlineData: { mimeType: "video/mp4", data: "AQID" }, videoMetadata: { fps: 10 } }]);
      else assert.deepEqual(content, [{ type: "video_url", video_url: { url: "data:video/mp4;base64,AQID" } }]);
      return createSseResponse(type === "dashscope" ? [{ output: { choices: [{ message: { content: [{ text: "完成" }] } }] } }]
        : ["google", "vertex", "vertex_express"].includes(type) ? [{ candidates: [{ content: { parts: [{ text: "完成" }] } }] }]
        : [{ choices: [{ delta: { content: "完成" } }] }]);
    });
    const result = await getLlmProvider(ctx).generate(ctx, { messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,AQID" }, durationMs: 400, fps: 10 }] }], enableThinkingOverride: false });
    assert.equal(result.text, "完成");
  });
}

test("视频候选失败后按备用模型能力重做拼图，反向切换仍能得到视频", { skip: !ffmpegAvailable }, async () => {
  for (const reverse of [false, true]) {
    const config = createLlmTestConfig([
      { chat: { capabilities: { supportsVision: true, supportsVideoInput: !reverse } } },
      { chat: { capabilities: { supportsVision: true, supportsVideoInput: reverse } } }
    ]);
    const kinds: string[] = [];
    await withMockFetch([
      { assertRequest(body: any) { kinds.push(body.messages[0].content[0].type); }, response: new Response("temporarily unavailable", { status: 503 }) },
      { assertRequest(body: any) { kinds.push(body.messages[0].content[0].type); }, payloads: [{ choices: [{ delta: { content: "完成" } }] }] }
    ], async () => {
      const result = await new LlmClient(config, logger).generate({ messages: structuredClone(messages) });
      assert.equal(result.text, "完成");
    });
    assert.deepEqual(kinds, reverse ? ["image_url", "video_url"] : ["video_url", "image_url"]);
  }
});

test("模型清单只从明确视频模态发现视频能力", () => {
  const rows = parseDiscoveredModels({ data: [{ id: "video-name-only", architecture: { output_modalities: ["text"] } }, { id: "native", architecture: { output_modalities: ["text"], input_modalities: ["text", "image", "video"] } }] }, "test", "generic");
  assert.equal((rows[0]!.profile.chat as any).capabilities.supportsVideoInput, undefined);
  assert.equal((rows[1]!.profile.chat as any).capabilities.supportsVideoInput, true);
});

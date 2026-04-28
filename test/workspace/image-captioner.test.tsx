import test from "node:test";
import assert from "node:assert/strict";
import { MediaCaptionService } from "../../src/services/workspace/mediaCaptionService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

type TestFile = {
  fileId: string;
  kind: "image" | "animated_image";
  caption: string | null;
  captionStatus?: "missing" | "queued" | "ready" | "failed";
  captionUpdatedAtMs?: number;
  captionModelRef?: string | null;
  captionError?: string | null;
  sourceContext: Record<string, string | number | boolean | null>;
};

class FakeChatFileStore {
  constructor(private readonly files = new Map<string, TestFile>()) {}

  async getMany(fileIds: string[]) {
    return fileIds.map((fileId) => this.files.get(fileId)).filter((item): item is TestFile => Boolean(item));
  }

  async getFile(fileId: string) {
    return this.files.get(fileId) ?? null;
  }

  async markCaptionsQueued(fileIds: string[]) {
    for (const fileId of fileIds) {
      const file = this.files.get(fileId);
      if (file && !file.caption) {
        file.captionStatus = "queued";
        file.captionError = null;
      }
    }
  }

  async updateCaption(
    fileId: string,
    caption: string | null,
    metadata?: {
      status?: "missing" | "queued" | "ready" | "failed";
      modelRef?: string | null;
      error?: string | null;
      updatedAtMs?: number;
    }
  ) {
    const file = this.files.get(fileId);
    assert.ok(file);
    file.caption = caption;
    file.captionStatus = metadata?.status ?? (caption ? "ready" : "missing");
    file.captionModelRef = metadata?.modelRef ?? null;
    file.captionError = metadata?.error ?? null;
    file.captionUpdatedAtMs = metadata?.updatedAtMs ?? Date.now();
  }
}

function createCaptionerConfig() {
  return createTestAppConfig({
    llm: {
      enabled: true,
      providers: {
        vision: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "test-key",
          proxy: false
        }
      },
      models: {
        primary: {
          provider: "vision",
          model: "primary-model",
          supportsThinking: false,
          supportsVision: true,
          supportsAudioInput: false,
          supportsSearch: false,
          supportsTools: false,
          preserveThinking: false
        },
        secondary: {
          provider: "vision",
          model: "secondary-model",
          supportsThinking: false,
          supportsVision: true,
          supportsAudioInput: false,
          supportsSearch: false,
          supportsTools: false,
          preserveThinking: false
        }
      },
      routingPresets: {
        test: {
          mainSmall: ["main"],
          mainLarge: ["main"],
          summarizer: ["main"],
          sessionCaptioner: ["sessionCaptioner"],
          imageCaptioner: ["primary", "secondary"],
          audioTranscription: ["transcription"],
          turnPlanner: ["main"]
        }
      },
      imageCaptioner: {
        enabled: true,
        timeoutMs: 1000,
        enableThinking: false,
        maxConcurrency: 2
      }
    }
  });
}

  test("media caption service requests detailed captions and preserves nsfw detail", async () => {
    const chatFileStore = new FakeChatFileStore(new Map([
      ["file_nsfw", {
        fileId: "file_nsfw",
        kind: "image",
        caption: null,
        sourceContext: { mediaKind: "image" }
      }]
    ]));
    const llmClient = {
      isConfigured() {
        return true;
      },
      async generate(params: { messages: Array<{ role: string; content: unknown }> }) {
        const systemPrompt = String(params.messages[0]?.content ?? "");
        assert.match(systemPrompt, /尽可能详细/);
        assert.match(systemPrompt, /主体、动作、场景、构图、穿着或外观/);
        assert.match(systemPrompt, /画面中的可见文字/);
        assert.match(systemPrompt, /必须在开头加“NSFW ”/);
        assert.doesNotMatch(systemPrompt, /14 到 36 个字/);
        return {
          text: "成人: 半裸人物站在卧室镜前自拍，长发披肩，画面右侧有白色衣柜，左侧床铺凌乱，灯光偏暖",
          usage: {
            modelRef: "primary"
          }
        };
      }
    } as any;

    const captioner = new MediaCaptionService(
      createCaptionerConfig(),
      llmClient,
      chatFileStore as any,
      {
        async prepareFileForModel(fileId: string) {
          return {
            fileId,
            inputUrl: `data:image/png;base64,${fileId}`,
            kind: "image",
            transport: "data_url",
            animated: false,
            durationMs: null,
            sampledFrameCount: null
          };
        }
      } as any,
      createSilentLogger()
    );
    const captions = await captioner.ensureReady(["file_nsfw"], { reason: "test_nsfw" });

    assert.equal(captions.get("file_nsfw"), "NSFW 半裸人物站在卧室镜前自拍，长发披肩，画面右侧有白色衣柜，左侧床铺凌乱，灯光偏暖");
  });

  test("media caption service stores the actual fallback model when generation succeeds", async () => {
    const chatFileStore = new FakeChatFileStore(new Map([
      ["file_1", {
        fileId: "file_1",
        kind: "image",
        caption: null,
        sourceContext: { mediaKind: "image" }
      }]
    ]));
    const llmClient = {
      isConfigured(modelRef: string[]) {
        assert.deepEqual(modelRef, ["primary", "secondary"]);
        return true;
      },
      async generate(params: { modelRefOverride: string[] }) {
        assert.deepEqual(params.modelRefOverride, ["primary", "secondary"]);
        return {
          text: "窗边的小猫",
          usage: {
            modelRef: "secondary"
          }
        };
      }
    } as any;

    const captioner = new MediaCaptionService(
      createCaptionerConfig(),
      llmClient,
      chatFileStore as any,
      {
        async prepareFileForModel(fileId: string) {
          return {
            fileId,
            inputUrl: `data:image/png;base64,${fileId}`,
            kind: "image",
            transport: "data_url",
            animated: false,
            durationMs: null,
            sampledFrameCount: null
          };
        }
      } as any,
      createSilentLogger()
    );
    const captions = await captioner.ensureReady(["file_1"], { reason: "test_fallback" });

    assert.equal(captions.get("file_1"), "窗边的小猫");
    assert.equal((await chatFileStore.getFile("file_1"))?.captionStatus, "ready");
    assert.equal((await chatFileStore.getFile("file_1"))?.captionModelRef, "secondary");
    assert.equal((await chatFileStore.getFile("file_1"))?.captionError, null);
  });

  test("media caption service retries image and emoji-like files on demand", async () => {
    const chatFileStore = new FakeChatFileStore(new Map([
      ["file_missing", {
        fileId: "file_missing",
        kind: "image",
        caption: null,
        sourceContext: { mediaKind: "image" }
      }],
      ["file_failed", {
        fileId: "file_failed",
        kind: "animated_image",
        caption: null,
        sourceContext: { mediaKind: "emoji" }
      }]
    ]));
    const calls: string[][] = [];
    const llmClient = {
      isConfigured() {
        return true;
      },
      async generate(params: { modelRefOverride: string[]; messages: Array<{ role: string; content: unknown }> }) {
        calls.push(params.modelRefOverride);
        const prompt = params.messages[1]?.content as Array<{ type: string; text?: string }>;
        const isEmoji = prompt.some((item) => item.type === "text" && item.text?.includes("聊天表情图"));
        return {
          text: isEmoji ? "搞怪表情包" : "会议室白板照片",
          usage: {
            modelRef: "primary"
          }
        };
      }
    } as any;

    const captioner = new MediaCaptionService(
      createCaptionerConfig(),
      llmClient,
      chatFileStore as any,
      {
        async prepareFileForModel(fileId: string) {
          return {
            fileId,
            inputUrl: `data:image/png;base64,${fileId}`,
            kind: fileId === "file_failed" ? "animated_image" : "image",
            transport: "data_url",
            animated: fileId === "file_failed",
            durationMs: fileId === "file_failed" ? 1200 : null,
            sampledFrameCount: fileId === "file_failed" ? 3 : null
          };
        }
      } as any,
      createSilentLogger()
    );
    const captions = await captioner.ensureReady(["file_missing", "file_failed"], { reason: "test_retry" });

    assert.equal(captions.get("file_missing"), "会议室白板照片");
    assert.equal(captions.get("file_failed"), "搞怪表情包");
    assert.equal(calls.length, 2);
  });

import assert from "node:assert/strict";
import { MediaCaptionService } from "../src/services/workspace/mediaCaptionService.ts";
import { createTestAppConfig } from "./helpers/config-fixtures.tsx";
import { createSilentLogger } from "./helpers/browser-test-support.tsx";
import { runCase } from "./helpers/llm-test-support.tsx";

type TestAsset = {
  assetId: string;
  kind: "image" | "animated_image";
  caption: string | null;
  sourceContext: Record<string, string | number | boolean | null>;
};

class FakeMediaWorkspace {
  constructor(private readonly assets = new Map<string, TestAsset>()) {}

  async getMany(assetIds: string[]) {
    return assetIds.map((assetId) => this.assets.get(assetId)).filter((item): item is TestAsset => Boolean(item));
  }

  async getAsset(assetId: string) {
    return this.assets.get(assetId) ?? null;
  }

  async updateCaption(assetId: string, caption: string | null) {
    const asset = this.assets.get(assetId);
    assert.ok(asset);
    asset.caption = caption;
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
          forceNoThinkDirective: false,
          returnReasoningContentForAllMessages: false,
          returnReasoningContentForSameRoundMessages: true
        },
        secondary: {
          provider: "vision",
          model: "secondary-model",
          supportsThinking: false,
          supportsVision: true,
          supportsAudioInput: false,
          supportsSearch: false,
          supportsTools: false,
          forceNoThinkDirective: false,
          returnReasoningContentForAllMessages: false,
          returnReasoningContentForSameRoundMessages: true
        }
      },
      imageCaptioner: {
        enabled: true,
        modelRef: ["primary", "secondary"],
        timeoutMs: 1000,
        enableThinking: false,
        maxConcurrency: 2
      }
    }
  });
}

async function main() {
  await runCase("media caption service requests richer captions and normalizes nsfw labels", async () => {
    const mediaWorkspace = new FakeMediaWorkspace(new Map([
      ["asset_nsfw", {
        assetId: "asset_nsfw",
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
        assert.match(systemPrompt, /主体、动作、场景、构图、穿着或外观/);
        assert.match(systemPrompt, /必须在开头加“NSFW ”/);
        assert.match(systemPrompt, /尽量控制在 14 到 36 个字/);
        return {
          text: "成人: 半裸人物站在卧室镜前自拍，长发披肩",
          usage: {
            modelRef: "primary"
          }
        };
      }
    } as any;

    const captioner = new MediaCaptionService(
      createCaptionerConfig(),
      llmClient,
      mediaWorkspace as any,
      {
        async prepareAssetForModel(assetId: string) {
          return {
            assetId,
            inputUrl: `data:image/png;base64,${assetId}`,
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
    const captions = await captioner.ensureReady(["asset_nsfw"], { reason: "test_nsfw" });

    assert.equal(captions.get("asset_nsfw"), "NSFW 半裸人物站在卧室镜前自拍，长发披肩");
  });

  await runCase("media caption service stores the actual fallback model when generation succeeds", async () => {
    const mediaWorkspace = new FakeMediaWorkspace(new Map([
      ["asset_1", {
        assetId: "asset_1",
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
      mediaWorkspace as any,
      {
        async prepareAssetForModel(assetId: string) {
          return {
            assetId,
            inputUrl: `data:image/png;base64,${assetId}`,
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
    const captions = await captioner.ensureReady(["asset_1"], { reason: "test_fallback" });

    assert.equal(captions.get("asset_1"), "窗边的小猫");
  });

  await runCase("media caption service retries image and emoji-like assets on demand", async () => {
    const mediaWorkspace = new FakeMediaWorkspace(new Map([
      ["asset_missing", {
        assetId: "asset_missing",
        kind: "image",
        caption: null,
        sourceContext: { mediaKind: "image" }
      }],
      ["asset_failed", {
        assetId: "asset_failed",
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
      mediaWorkspace as any,
      {
        async prepareAssetForModel(assetId: string) {
          return {
            assetId,
            inputUrl: `data:image/png;base64,${assetId}`,
            kind: assetId === "asset_failed" ? "animated_image" : "image",
            transport: "data_url",
            animated: assetId === "asset_failed",
            durationMs: assetId === "asset_failed" ? 1200 : null,
            sampledFrameCount: assetId === "asset_failed" ? 3 : null
          };
        }
      } as any,
      createSilentLogger()
    );
    const captions = await captioner.ensureReady(["asset_missing", "asset_failed"], { reason: "test_retry" });

    assert.equal(captions.get("asset_missing"), "会议室白板照片");
    assert.equal(captions.get("asset_failed"), "搞怪表情包");
    assert.equal(calls.length, 2);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

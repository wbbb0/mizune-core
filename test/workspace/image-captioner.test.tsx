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

  async clearCaptionQueued(fileId: string, isUnowned: () => boolean) {
    const file = this.files.get(fileId);
    if (isUnowned() && file?.captionStatus === "queued" && !file.caption) file.captionStatus = "missing";
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
          type: "openai_compatible",
          baseUrl: "https://example.com/v1",
          apiKey: "test-key",
          proxy: false
        }
      },
      models: {
        primary: {
          provider: "vision",
          model: "primary-model",
          chat: { capabilities: { supportsThinking: false, supportsVision: true, supportsAudioInput: false, supportsTools: false, supportsSearch: false }, preserveThinking: false }
        },
        secondary: {
          provider: "vision",
          model: "secondary-model",
          chat: { capabilities: { supportsThinking: false, supportsVision: true, supportsAudioInput: false, supportsTools: false, supportsSearch: false }, preserveThinking: false }
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

function createMixedVisionCaptionerConfig() {
  return createTestAppConfig({
    llm: {
      enabled: true,
      providers: {
        vision: {
          type: "openai_compatible",
          baseUrl: "https://example.com/v1",
          apiKey: "test-key",
          proxy: false
        }
      },
      models: {
        textOnly: {
          provider: "vision",
          model: "text-only-model",
          chat: { capabilities: { supportsThinking: false, supportsVision: false, supportsAudioInput: false, supportsTools: false, supportsSearch: false }, preserveThinking: false }
        },
        visual: {
          provider: "vision",
          model: "visual-model",
          chat: { capabilities: { supportsThinking: false, supportsVision: true, supportsAudioInput: false, supportsTools: false, supportsSearch: false }, preserveThinking: false }
        }
      },
      routingPresets: {
        test: {
          mainSmall: ["main"],
          mainLarge: ["main"],
          summarizer: ["main"],
          sessionCaptioner: ["sessionCaptioner"],
          imageCaptioner: ["textOnly", "visual"],
          imageInspector: ["visual"],
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

function createRecordingLogger() {
  const warnings: Array<{ payload: unknown; message: string }> = [];
  return {
    warnings,
    logger: {
      debug() {},
      warn(payload: unknown, message: string) {
        warnings.push({ payload, message });
      }
    } as any
  };
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

  test("media caption service ignores non-vision captioner models and logs a warning", async () => {
    const chatFileStore = new FakeChatFileStore(new Map([
      ["file_vision", {
        fileId: "file_vision",
        kind: "image",
        caption: null,
        sourceContext: { mediaKind: "image" }
      }]
    ]));
    const logger = createRecordingLogger();
    const llmClient = {
      isConfigured(modelRefs: string[]) {
        assert.deepEqual(modelRefs, ["visual"]);
        return true;
      },
      async generate(params: { modelRefOverride: string[] }) {
        assert.deepEqual(params.modelRefOverride, ["visual"]);
        return {
          text: "白板上的流程图",
          usage: {
            modelRef: "visual"
          }
        };
      }
    } as any;

    const captioner = new MediaCaptionService(
      createMixedVisionCaptionerConfig(),
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
      logger.logger
    );
    const captions = await captioner.ensureReady(["file_vision"], { reason: "mixed_vision" });

    assert.equal(captions.get("file_vision"), "白板上的流程图");
    assert.equal(logger.warnings.length, 1);
    assert.equal(logger.warnings[0]?.message, "vision_model_ref_ignored");
    assert.deepEqual((logger.warnings[0]?.payload as any).modelRefs, ["textOnly"]);
    assert.equal((logger.warnings[0]?.payload as any).role, "image_captioner");
  });

function pendingResult<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let tries = 0; !predicate(); tries++) {
    if (tries > 1000) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function lifecycleCaptioner(run: (params: { abortSignal: AbortSignal }) => Promise<{ text: string; usage: { modelRef: string } }>, config = createCaptionerConfig()) {
  const store = new FakeChatFileStore(new Map(["a", "b"].map(fileId => [fileId, {
    fileId, kind: "image" as const, caption: null, captionStatus: "missing" as const, sourceContext: { mediaKind: "image" }
  }])));
  const service = new MediaCaptionService(config, { isConfigured: () => true, generate: run } as any, store as any,
    { async prepareFileForModel(fileId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      return { fileId, inputUrl: "data:image/png;base64,AA==" };
    } } as any, createSilentLogger());
  return { store, service };
}

test("caption requests share work while cancellation releases only the caller's lease", async () => {
  const answer = pendingResult<{ text: string; usage: { modelRef: string } }>();
  let calls = 0;
  let taskSignal!: AbortSignal;
  const { service } = lifecycleCaptioner(async params => { calls++; taskSignal = params.abortSignal; return answer.promise; });
  const controller = new AbortController();
  const first = service.ensureReady(["a"], { abortSignal: controller.signal });
  const second = service.ensureReady(["a"]);
  await waitUntil(() => calls === 1);
  controller.abort(new Error("first cancelled"));
  await assert.rejects(first, /first cancelled/);
  assert.equal(taskSignal.aborted, false);
  answer.resolve({ text: "共享结果", usage: { modelRef: "primary" } });
  assert.equal((await second).get("a"), "共享结果");
  assert.equal(calls, 1);
  await service.stop();
});

test("cancelled old caption cannot overwrite a newer result or leave queued status behind", async () => {
  const oldAnswer = pendingResult<{ text: string; usage: { modelRef: string } }>();
  let calls = 0;
  const { service, store } = lifecycleCaptioner(async () => {
    calls++;
    if (calls === 1) return oldAnswer.promise;
    return { text: "新结果", usage: { modelRef: "primary" } };
  });
  const controller = new AbortController();
  const old = service.ensureReady(["a"], { abortSignal: controller.signal });
  await waitUntil(() => calls === 1);
  controller.abort(new Error("superseded"));
  await assert.rejects(old, /superseded/);
  assert.equal((await service.ensureReady(["a"])).get("a"), "新结果");
  oldAnswer.resolve({ text: "旧结果", usage: { modelRef: "primary" } });
  await service.stop();
  assert.equal((await store.getFile("a"))?.caption, "新结果");
  assert.equal((await store.getFile("a"))?.captionStatus, "ready");
});

test("last caption owner cancellation discards queued work and returns active status to missing", async () => {
  const config = createCaptionerConfig();
  config.llm.imageCaptioner.maxConcurrency = 1;
  const answer = pendingResult<{ text: string; usage: { modelRef: string } }>();
  let calls = 0;
  let taskSignal!: AbortSignal;
  const { service, store } = lifecycleCaptioner(async params => { calls++; taskSignal = params.abortSignal; return answer.promise; }, config);
  const controller = new AbortController();
  const pending = service.ensureReady(["a", "b"], { abortSignal: controller.signal });
  await waitUntil(() => calls === 1);
  controller.abort(new Error("request cancelled"));
  await assert.rejects(pending, /request cancelled/);
  assert.equal(taskSignal.aborted, true);
  answer.resolve({ text: "迟到结果", usage: { modelRef: "primary" } });
  await service.stop();
  assert.equal(calls, 1);
  assert.equal((await store.getFile("a"))?.caption, null);
  assert.equal((await store.getFile("a"))?.captionStatus, "missing");
  assert.equal((await store.getFile("b"))?.captionStatus, "missing");
});

test("background caption owner expires and does not persist a late model result", async () => {
  const config = createCaptionerConfig();
  config.llm.imageCaptioner.timeoutMs = 20;
  const answer = pendingResult<{ text: string; usage: { modelRef: string } }>();
  let taskSignal!: AbortSignal;
  const { service, store } = lifecycleCaptioner(async params => { taskSignal = params.abortSignal; return answer.promise; }, config);
  service.schedule(["a"], "synthetic background");
  await waitUntil(() => Boolean(taskSignal?.aborted));
  answer.resolve({ text: "后台迟到", usage: { modelRef: "primary" } });
  await service.stop();
  assert.equal((await store.getFile("a"))?.caption, null);
  assert.equal((await store.getFile("a"))?.captionStatus, "missing");
});

test("caption preparation reports individual completed results before the whole batch finishes", async () => {
  const second = pendingResult<{ text: string; usage: { modelRef: string } }>();
  let calls = 0;
  const snapshots: Map<string, string>[] = [];
  const { service } = lifecycleCaptioner(async () => ++calls === 1
    ? { text: "先完成", usage: { modelRef: "primary" } } : second.promise);
  const pending = service.ensureReady(["a", "b"], { onProgress: results => snapshots.push(new Map(results)) });
  await waitUntil(() => snapshots.some(results => results.get("a") === "先完成"));
  assert.equal(snapshots.at(-1)?.has("b"), false);
  second.resolve({ text: "后完成", usage: { modelRef: "primary" } });
  assert.equal((await pending).size, 2);
  await service.stop();
});

test("cancellation while a failed-caption write waits still clears unowned queued status", async () => {
  const gate = pendingResult<void>();
  let failedWrite = false;
  const { service, store } = lifecycleCaptioner(async () => { throw new Error("ordinary model failure"); });
  const update = store.updateCaption.bind(store);
  (store as any).updateCaption = async (id: string, caption: string | null, metadata: { status?: "missing" | "queued" | "ready" | "failed" }, signal?: AbortSignal) => {
    if (metadata.status === "failed") { failedWrite = true; await gate.promise; }
    signal?.throwIfAborted();
    return update(id, caption, metadata);
  };
  const controller = new AbortController();
  const pending = service.ensureReady(["a"], { abortSignal: controller.signal });
  await waitUntil(() => failedWrite);
  controller.abort(new Error("cancel failed write"));
  await assert.rejects(pending, /cancel failed write/);
  gate.resolve();
  await service.stop();
  assert.equal((await store.getFile("a"))?.captionStatus, "missing");
  assert.equal((await store.getFile("a"))?.captionError, null);
});

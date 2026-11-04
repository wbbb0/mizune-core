import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { withTempDir } from "../helpers/config-test-support.tsx";
import { nativeCapabilityToolHandlers, isSpeechGenerationAvailable, isDecisionAvailable } from "../../src/llm/tools/runtime/nativeCapabilityTools.ts";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { createEmptyUsage } from "../../src/llm/provider/providerTypes.ts";
import { listTurnToolsets, listConfigurableSessionToolsets, resolveToolNamesFromToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import { getBuiltinTools } from "../../src/llm/builtinTools.ts";

function config() {
  return createTestAppConfig({ llm: {
    enabled: true, speechGeneration: { enabled: true }, decision: { enabled: true },
    providers: { native: { type: "openai", apiKey: "test" } },
    models: { speech: { provider: "native", model: "speech-model", speech: {} }, decision: { provider: "native", model: "decision-model", decision: {} } },
    routingPresets: { test: { speechGenerator: ["speech"], decision: ["decision"] } }
  }, chatFiles: { enabled: true } });
}
const call = (name: string) => ({ id: "test", type: "function" as const, function: { name, arguments: "{}" } });

test("语音与决策工具沿真实模式候选目录和 all/planned 选择链可见，遵守会话 override", () => {
  const c = config();
  const names = ["generate_speech", "make_decision"];
  for (const modeId of ["assistant", "rp_assistant", "stateful_rp", "scenario_host"]) {
    const defaultEnabled = modeId === "assistant" || modeId === "rp_assistant";
    const list = (overrides: Record<string, "enabled" | "disabled"> = {}) => listTurnToolsets({ config: c, relationship: "owner", currentUser: null, modelRef: ["main"], includeDebugTools: false, modeId, toolsetPreferences: { overrides } });
    const defaults = list();
    if (!defaultEnabled) {
      assert.ok(defaults.every(item => item.id !== "asset_io"));
      assert.ok(list({ asset_io: "enabled", speech_generation: "enabled" }).some(item => item.id === "asset_io"));
    }
    for (const id of ["speech_generation", "native_decisions"]) {
      assert.equal(defaults.some(item => item.id === id), defaultEnabled, `${modeId}/${id} default`);
      const configurable = listConfigurableSessionToolsets(modeId, { overrides: {} }).find(item => item.id === id);
      assert.equal(configurable?.defaultEnabled, defaultEnabled);
    }
    const enabled = list({ speech_generation: "enabled", native_decisions: "enabled" });
    for (const toolSelection of ["all", "planned"] as const) {
      c.llm.turnPlanner.toolSelection = toolSelection;
      const selected = toolSelection === "all" ? enabled.map(item => item.id) : ["speech_generation", "native_decisions"];
      const allowed = resolveToolNamesFromToolsets(enabled, selected);
      const tools = getBuiltinTools("owner", null, c, { modelRef: ["main"], availableToolNames: allowed }).map(tool => tool.function.name);
      for (const name of names) assert.ok(tools.includes(name), `${modeId}/${toolSelection}/${name}`);
    }
    const disabled = list({ speech_generation: "disabled", native_decisions: "disabled" });
    assert.ok(disabled.every(item => !["speech_generation", "native_decisions"].includes(item.id)));
    assert.equal(resolveToolNamesFromToolsets(disabled, ["speech_generation", "native_decisions"]).length, 0);
    // An unrelated mode-scoped capability cannot be enabled by a sparse session override.
    if (modeId === "scenario_host") assert.ok(list({ shell_runtime: "enabled" }).every(item => item.id !== "shell_runtime"));
  }
  c.llm.speechGeneration.enabled = false;
  c.llm.decision.enabled = false;
  const hidden = listTurnToolsets({ config: c, relationship: "owner", currentUser: null, modelRef: ["main"], includeDebugTools: false, modeId: "assistant", toolsetPreferences: { overrides: { speech_generation: "enabled", native_decisions: "enabled" } } });
  assert.ok(hidden.every(item => !["speech_generation", "native_decisions"].includes(item.id)));
});

test("生成语音工具创建受管音频资产和可发送句柄", async () => {
  await withTempDir("speech-tool", async directory => {
    const c = config();
    c.dataDir = directory;
    c.localFiles.root = directory;
    c.chatFiles.root = "files";
    const store = new ChatFileStore(c, pino({ level: "silent" }), new LocalFileService(c, directory));
    await store.init();
    let calls = 0;
    const context = { config: c, chatFileStore: store, nativeCapabilities: {
      async synthesize(params) {
        calls++;
        assert.equal(params.text, "你好");
        assert.equal(params.speed, 1.25);
        return { buffer: Buffer.from("ID3audio"), mimeType: "audio/mpeg", extension: "mp3", usage: createEmptyUsage("speech", "speech-model") };
      }
    } } as BuiltinToolContext;
    const result = JSON.parse(String(await nativeCapabilityToolHandlers.generate_speech!(call("generate_speech"), { text: "你好", speed: 1.25 }, context)));
    assert.equal(result.ok, true);
    assert.equal(result.ai_generated, true);
    assert.equal(result.file.kind, "audio");
    assert.equal(result.asset_handle.kind, "audio");
    assert.equal((await store.getFile(result.file_id))?.origin, "audio_generated");
    assert.ok(result.asset_handle.capabilities.some((cap: { capability: string }) => cap.capability === "send_to_chat"));
    assert.equal(calls, 1);
  });
});

test("原生工具按配置和供应商能力隐藏，禁用后处理器也拒绝执行", async () => {
  const c = config();
  assert.equal(isSpeechGenerationAvailable(c), true);
  assert.equal(isDecisionAvailable(c), true);
  c.llm.providers.native!.type = "openai_compatible";
  assert.equal(isSpeechGenerationAvailable(c), false);
  assert.equal(isDecisionAvailable(c), false);
  const context = { config: c } as BuiltinToolContext;
  const speech = JSON.parse(String(await nativeCapabilityToolHandlers.generate_speech!(call("generate_speech"), { text: "你好" }, context)));
  assert.equal(speech.ok, false);
});

test("决策工具保留拒绝结果且不执行返回选项代表的动作", async () => {
  const c = config();
  let calls = 0;
  const context = { config: c, nativeCapabilities: { async decide(params) {
    calls++;
    assert.equal(params.input, "证据");
    return { answers: [{ name: "test", type: "refusal" }], usage: createEmptyUsage("decision", "decision-model") };
  } } } as BuiltinToolContext;
  const result = JSON.parse(String(await nativeCapabilityToolHandlers.make_decision!(call("make_decision"), { input: "证据", questions: [{ type: "predicate", name: "test", instructions: "是否满足条件？" }] }, context)));
  assert.deepEqual(result.answers, [{ name: "test", type: "refusal" }]);
  assert.equal(calls, 1);
});

test("生成语音资产沿音频消息链路投递到 OneBot 与 Web 并可播放", async () => {
  const { chatFileToolHandlers } = await import("../../src/llm/tools/runtime/workspaceTools.ts");
  const { transcriptOutboundMediaMessageItemSchema } = await import("../../src/conversation/session/transcriptContract.ts");
  const { projectChatTimelineFromTranscript } = await import("../../src/conversation/session/sessionTranscript.ts");
  const { buildChatTimelineItems } = await import("../../webui/src/components/sessions/chatTimeline.ts");
  await withTempDir("speech-delivery", async directory => {
    const c = config();
    c.dataDir = directory;
    c.chatFiles.root = "files";
    const store = new ChatFileStore(c, pino({ level: "silent" }), new LocalFileService(c, directory));
    await store.init();
    const audio = Buffer.from("ID3audio");
    for (const delivery of ["onebot", "web"] as const) {
      const queued: Array<() => Promise<void>> = [];
      const sends: unknown[] = [];
      const transcripts: unknown[] = [];
      const context = {
        config: c,
        replyDelivery: delivery,
        lastMessage: { sessionId: "qqbot:p:123", userId: "123", senderName: "测试" },
        chatFileStore: store,
        nativeCapabilities: {
          async synthesize() { return { buffer: audio, mimeType: "audio/mpeg", extension: "mp3", usage: createEmptyUsage("speech", "speech-model") }; }
        },
        messageQueue: { enqueueTextDetached(params: { send: () => Promise<void> }) { queued.push(params.send); } },
        oneBotClient: {
          async sendMessage(params: unknown) { sends.push(params); return { status: "ok", retcode: 0, data: { message_id: 42 } }; },
          async sendFile() { throw new Error("音频不应当作为普通文件上传"); }
        },
        sessionManager: {
          recordSentMessage() {},
          appendInternalTranscript(_sessionId: string, item: unknown) { transcripts.push(item); }
        }
      } as unknown as BuiltinToolContext;
      const generated = JSON.parse(String(await nativeCapabilityToolHandlers.generate_speech!(call("generate_speech"), { text: "你好" }, context)));
      assert.equal(generated.ok, true);
      assert.equal(generated.asset_handle.capabilities.find((cap: { capability: string }) => cap.capability === "send_to_chat").requires, undefined);
      const sent = await chatFileToolHandlers.asset_send_to_chat!(call("asset_send_to_chat"), { asset_ref: generated.asset_ref }, context);
      const result = JSON.parse(typeof sent === "string" ? sent : sent.content);
      assert.equal(result.deliveredAs, "audio");
      assert.equal(queued.length, 1);
      assert.equal(transcripts.length, 0);
      await queued[0]!();
      assert.equal(sends.length, delivery === "onebot" ? 1 : 0);
      if (delivery === "onebot") assert.deepEqual(sends[0], { userId: "123", message: [{ type: "record", data: { file: `base64://${audio.toString("base64")}` } }] });
      const transcript = transcriptOutboundMediaMessageItemSchema.parse({ ...transcripts[0] as object, id: `item-${delivery}`, groupId: "group", runtimeExcluded: false });
      assert.equal(transcript.mediaKind, "audio");
      assert.equal(transcript.aiGenerated, true);
      assert.equal(transcript.mimeType, "audio/mpeg");
      assert.equal(projectChatTimelineFromTranscript([transcript])[0]?.kind, "audio");
      const timeline = buildChatTimelineItems([{ id: "entry", eventId: "event", index: 0, item: { ...transcript, id: `item-${delivery}`, groupId: "group", runtimeExcluded: false } }]);
      const entry = timeline[0];
      assert.equal(entry?.kind, "content_parts");
      if (entry?.kind !== "content_parts") throw new Error("expected content parts");
      assert.deepEqual(entry.parts, [{ kind: "audio", fileId: generated.file_id, name: "generated.mp3", mimeType: "audio/mpeg", contentUrl: `/api/chat-files/${generated.file_id}/content`, aiGenerated: true }]);
    }
  });
});

test("语音排队后取消不会投递或写入已发送事件，预取消不读取资产", async () => {
  const { chatFileToolHandlers } = await import("../../src/llm/tools/runtime/workspaceTools.ts");
  const { MessageQueue } = await import("../../src/conversation/messageQueue.ts");
  await withTempDir("speech-delivery-abort", async directory => {
    const c = config(); c.dataDir = directory; c.chatFiles.root = "files";
    const logger = pino({ level: "silent" });
    const store = new ChatFileStore(c, logger, new LocalFileService(c, directory));
    await store.init();
    const source = await store.importBuffer({ buffer: Buffer.from("ID3audio"), sourceName: "generated.mp3", mimeType: "audio/mpeg", kind: "audio", origin: "audio_generated" });
    const queue = new MessageQueue(logger, c);
    const controller = new AbortController();
    let release!: () => void;
    queue.enqueueDetached("qqbot:p:123", () => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    let sends = 0;
    let events = 0;
    const context = {
      config: c, abortSignal: controller.signal, replyDelivery: "onebot", lastMessage: { sessionId: "qqbot:p:123" }, chatFileStore: store, messageQueue: queue,
      oneBotClient: { async sendMessage() { sends++; return { data: { message_id: 42 } }; } },
      sessionManager: { recordSentMessage() { events++; }, appendInternalTranscript() { events++; } }
    } as unknown as BuiltinToolContext;
    const result = await chatFileToolHandlers.asset_send_to_chat!(call("asset_send_to_chat"), { asset_ref: source.fileRef }, context);
    assert.equal(JSON.parse(typeof result === "string" ? result : result.content).queued, true);
    controller.abort();
    release();
    await queue.getDrainPromise("qqbot:p:123");
    assert.equal(sends, 0);
    assert.equal(events, 0);
    await assert.rejects(chatFileToolHandlers.asset_send_to_chat!(call("asset_send_to_chat"), { asset_ref: source.fileRef }, context), /abort/i);
  });
});

test("决策工具传递结构化证据与受管图片，拒绝任意路径 URL 和非法资产", async () => {
  const sharp = (await import("sharp")).default;
  const { MediaVisionService } = await import("../../src/services/workspace/mediaVisionService.ts");
  await withTempDir("decision-evidence", async directory => {
    const c = config(); c.dataDir = directory; c.chatFiles.root = "files";
    const logger = pino({ level: "silent" });
    const store = new ChatFileStore(c, logger, new LocalFileService(c, directory));
    await store.init();
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "orange" } }).png().toBuffer();
    const source = await store.importBuffer({ buffer: png, sourceName: "evidence.png", mimeType: "image/png", kind: "image", origin: "user_upload" });
    const nonImage = await store.importBuffer({ buffer: Buffer.from("plain"), sourceName: "evidence.txt", mimeType: "text/plain", kind: "file", origin: "user_upload" });
    let requests = 0;
    const inputs: unknown[] = [];
    let guards = 0;
    const vision = new MediaVisionService(c, logger, store, { async guardChatFileForLlm() { guards++; return "allow"; } });
    const context = { config: c, chatFileStore: store, mediaVisionService: vision, nativeCapabilities: {
      async decide(params) { requests++; inputs.push(params.input); return { answers: [{ name: "test", type: "predicate", probability: 0.8 }], usage: createEmptyUsage("decision", "decision-model") }; }
    } } as BuiltinToolContext;
    const questions = [{ type: "predicate", name: "test", instructions: "证据是否满足条件？" }];
    const invoke = async (extra: Record<string, unknown>) => JSON.parse(String(await nativeCapabilityToolHandlers.make_decision!(call("make_decision"), { input: "证据", questions, ...extra }, context)));
    assert.equal((await invoke({ data: { score: 3, path: "/not/read", url: "https://not-fetched.example" }, reference_images: [source.fileRef] })).ok, true);
    assert.equal(guards, 1);
    const input = inputs[0] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.equal(input[0]?.role, "user");
    assert.deepEqual(input[0]?.content.slice(0, 2), [{ type: "input_text", text: "证据" }, { type: "input_json", data: { score: 3, path: "/not/read", url: "https://not-fetched.example" } }]);
    assert.equal(input[0]?.content[2]?.type, "input_image");
    assert.match(String(input[0]?.content[2]?.image_url), /^data:image\/png;base64,/);
    assert.equal((await invoke({ data: [{ value: 1 }, { value: 2 }] })).ok, true);
    for (const extra of [
      { reference_images: ["/tmp/not-an-asset.png"] },
      { reference_images: ["https://untrusted.example/image.png"] },
      { reference_images: [nonImage.fileRef] },
      { reference_images: ["missing"] },
      { reference_images: [] },
      { data: "plain JSON string" },
      { data: [1] },
      { data: { value: "a".repeat(256 * 1024) } }
    ]) assert.equal((await invoke(extra)).ok, false);
    assert.equal(requests, 2);
    context.mediaVisionService = new MediaVisionService(c, logger, store, { async guardChatFileForLlm() { throw new Error("内容访问被拒绝"); } });
    assert.equal((await invoke({ reference_images: [source.fileId] })).ok, false);
    assert.equal(requests, 2);
  });
});

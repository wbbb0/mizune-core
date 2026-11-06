import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { llmCatalogProviderFileSchema } from "#config/configModel.ts";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { listProviderModelSlots } from "#llm/provider/modelListDiscovery.ts";
import { MODELS_DEV_URL, ModelsDevCatalog, modelsDevModelProfile, parseModelsDevCatalog, resolveModelsDevProvider, supplementModelsDevMetadata } from "#llm/provider/modelsDevCatalog.ts";
import type { ModelDiscoveryInput, NativeModelDiscoveryResult } from "#llm/provider/modelDiscoveryTypes.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";

const chat = {
  name: "测试对话模型", modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
  tool_call: true, reasoning: true, structured_output: true,
  reasoning_options: [{ type: "toggle" }], limit: { context: 32768, input: 24000, output: 8000 }
};
const catalog = parseModelsDevCatalog({
  openai: { models: {
    chat, vector: { type: "embedding", limit: { input: 8192 } }, image: { type: "image", modalities: { input: ["text", "image"], output: ["image"] } },
    speech: { type: "speech" }, transcription: { type: "transcription" }, decision: { type: "decision", modalities: { output: ["text"] } },
    realtime: { ...chat, type: "realtime" }, video: { ...chat, type: "video" }, unavailable: chat
  } },
  openrouter: { api: "https://openrouter.ai/api/v1", models: { chat, vector: { type: "embedding", limit: { context: 4096 } } } },
  custom: { api: "https://gateway.example/v1/", models: { chat } },
  "alibaba-cn": { api: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: { chat } }
});
function input(provider: Record<string, unknown> = { type: "openai" }): ModelDiscoveryInput {
  return { config: createTestAppConfig(), provider: llmCatalogProviderFileSchema.parseFromObject({ ...provider, models: {} }) };
}
function native(): Extract<NativeModelDiscoveryResult, { kind: "ok" }> {
  return { kind: "ok", providerType: "openai", endpoint: "https://api.openai.com/v1/models", warnings: [], models: [{ id: "chat", source: "native", profile: {} }] };
}

test("基类补齐真实清单，自动分类且保留手工配置，不扩充可用模型", async () => {
  const calls: string[] = [];
  setFetchImplementationForTests(async (url, init) => {
    calls.push(url);
    if (url === MODELS_DEV_URL) {
      assert.equal(new Headers(init?.headers as HeadersInit).get("authorization"), null);
      assert.equal(new Headers(init?.headers as HeadersInit).get("x-api-key"), null);
      assert.equal(init?.body, undefined);
      return Response.json(catalog);
    }
    assert.equal(new Headers(init?.headers as HeadersInit).get("authorization"), "Bearer synthetic-key");
    return Response.json({ data: ["chat", "vector", "image", "speech", "transcription", "decision", "realtime", "video", "unknown"].map(id => ({ id })) });
  });
  try {
    const ctx = input({ type: "openai", apiKey: "synthetic-key" });
    const result = await listProviderModelSlots({ ...ctx, existingModels: { manual: { upstreamModel: "chat", chat: { capabilities: { supportsTools: false }, limits: { contextTokens: 4096 }, defaults: { temperature: 0 } } } } });
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.models.length, 9);
    assert.deepEqual(result.warnings, []);
    const model = result.models.find(model => model.upstreamModel === "chat")!;
    assert.equal(model.alias, "manual");
    assert.equal((model.profile.chat as any).capabilities.supportsTools, false);
    assert.equal((model.profile.chat as any).capabilities.supportsVision, true);
    assert.equal((model.profile.chat as any).capabilities.supportsStructuredOutput, true);
    assert.equal((model.profile.chat as any).capabilities.supportsAudioInput, undefined);
    assert.equal((model.profile.chat as any).limits.contextTokens, 4096);
    assert.equal((model.suggested.chat as any).limits.contextTokens, 32768);
    assert.deepEqual((model.profile.chat as any).defaults, { temperature: 0 });
    assert.ok(model.sources.some(source => source.startsWith(MODELS_DEV_URL)));
    for (const operation of ["embedding", "image", "speech", "transcription", "decision"]) {
      const id = operation === "embedding" ? "vector" : operation;
      assert.ok(result.models.find(model => model.upstreamModel === id)!.profile[operation]);
    }
    for (const id of ["realtime", "video", "unknown"]) assert.equal(result.models.find(model => model.upstreamModel === id)!.profile.chat, undefined);
    assert.equal(result.models.some(model => model.upstreamModel === "unavailable"), false);
    await listProviderModelSlots(ctx);
    assert.equal(calls.filter(url => url === MODELS_DEV_URL).length, 1);
  } finally { setFetchImplementationForTests(null); }
});

test("OpenRouter 重写原生发现入口，原生分类和限制优先于目录", async () => {
  const calls: string[] = [];
  setFetchImplementationForTests(async url => {
    if (url === MODELS_DEV_URL) return Response.json(catalog);
    calls.push(url);
    if (url.endsWith("/images/models")) return new Response("", { status: 503 });
    if (url.endsWith("/embeddings/models")) return Response.json({ data: [{ id: "vector", context_length: 1024 }] });
    return Response.json({ data: [{ id: "chat", context_length: 2048, supported_parameters: [], architecture: { input_modalities: ["text"] } }] });
  });
  try {
    const result = await listProviderModelSlots(input({ type: "openrouter" }));
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(calls.length, 3);
    assert.equal(result.warnings.length, 1);
    const model = result.models.find(model => model.upstreamModel === "chat")!;
    assert.equal((model.profile.chat as any).limits.contextTokens, 2048);
    assert.equal((model.profile.chat as any).capabilities.supportsTools, false);
    assert.equal((model.profile.chat as any).capabilities.supportsVision, false);
    assert.equal((model.profile.chat as any).capabilities.supportsStructuredOutput, true);
    assert.equal((result.models.find(model => model.upstreamModel === "vector")!.profile.embedding as any).limits.maxInputTokens, 1024);
  } finally { setFetchImplementationForTests(null); }
});

test("供应商依据明确类型、精确接口地址或显式映射识别，未知网关不借用同名模型", () => {
  assert.equal(resolveModelsDevProvider(catalog, input({ type: "openai_compatible", baseUrl: "https://gateway.example/v1" })), "custom");
  assert.equal(resolveModelsDevProvider(catalog, input({ type: "openai_compatible", baseUrl: "https://unknown.example/v1" })), undefined);
  assert.equal(resolveModelsDevProvider(catalog, input({ type: "openai_responses_compatible", baseUrl: "https://unknown.example/v1", modelsDevProvider: "openai" })), "openai");
  assert.equal(resolveModelsDevProvider(catalog, input({ type: "openai" })), "openai");
  assert.equal(resolveModelsDevProvider(catalog, input({ type: "dashscope" })), "alibaba-cn");
  assert.equal(resolveModelsDevProvider(catalog, input({ type: "deepseek", baseUrl: "https://proxy.example/anthropic" })), "deepseek");
  const ambiguous = { ...catalog, duplicate: catalog.custom! };
  assert.equal(resolveModelsDevProvider(ambiguous, input({ type: "openai_compatible", baseUrl: "https://gateway.example/v1" })), undefined);
});

test("缺失、非法上限及控制未知仍保留未知，不根据名称或推理支持推断可关闭", () => {
  const profile = modelsDevModelProfile({ ...chat, reasoning_options: [], limit: { context: 0, input: -1, output: "4096" } }, "google");
  assert.deepEqual((profile.chat as any).limits, {});
  assert.equal((profile.chat as any).capabilities.thinkingControllable, undefined);
  assert.equal((profile.chat as any).capabilities.supportsSearch, undefined);
  assert.equal((profile.chat as any).defaults, undefined);
  assert.deepEqual(modelsDevModelProfile({ name: "text-embedding-image-chat" }, "openai_compatible"), { displayName: "text-embedding-image-chat" });
  assert.equal(modelsDevModelProfile({ ...chat, type: "decision" }, "anthropic").decision, undefined);
  assert.equal(modelsDevModelProfile({ ...chat, type: "transcription" }, "openai_compatible").transcription, undefined);
  assert.equal(modelsDevModelProfile({ ...chat, type: "image" }, "openai_compatible").image, undefined);
  assert.equal((modelsDevModelProfile(chat, "anthropic").chat as any).capabilities.supportsVideoInput, undefined);
});

test("匹配必须是供应商内完整 ID，原生用途不被目录的不同类型扩展", () => {
  const rows = [{ id: "chat", profile: { embedding: {} }, source: "native" }, { id: "chat:free", profile: {}, source: "native" }];
  const models = supplementModelsDevMetadata(rows, catalog, "openai", "openai");
  assert.equal(models.length, 3);
  assert.equal(models[2]!.profile.chat, undefined);
  assert.deepEqual(rows[0]!.profile, { embedding: {} });
  assert.throws(() => parseModelsDevCatalog({ data: [] }), /格式/);
  assert.deepEqual(supplementModelsDevMetadata(rows, catalog, "toString", "openai"), rows);
});

test("公共目录失败保留原生结果及警告，冷却期内不重复请求，恢复后重新填充", async () => {
  let now = 1, calls = 0;
  const service = new ModelsDevCatalog(async () => { calls++; if (calls === 1) throw new Error("offline"); return catalog; }, () => now);
  const ctx = input();
  const first = await service.enrich(native(), ctx);
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;
  assert.deepEqual(first.models, native().models);
  assert.match(first.warnings[0]!, /暂不可用/);
  await service.enrich(native(), ctx); assert.equal(calls, 1);
  now += 60001;
  const recovered = await service.enrich(native(), ctx);
  assert.equal(calls, 2);
  if (recovered.kind !== "ok") return;
  assert.deepEqual(recovered.warnings, []); assert.equal(recovered.models.length, 2);
});

test("过期缓存更新失败时继续使用已知元信息，网络路径独立缓存", async () => {
  let now = 1, calls = 0;
  const service = new ModelsDevCatalog(async () => { calls++; if (calls === 2) throw new Error("offline"); return catalog; }, () => now);
  const ctx = input();
  await service.enrich(native(), ctx);
  now += 60 * 60 * 1000 + 1;
  const stale = await service.enrich(native(), ctx);
  if (stale.kind !== "ok") return assert.fail("unexpected");
  assert.equal(stale.models.length, 2); assert.match(stale.warnings[0]!, /缓存/);
  const proxied = input({ type: "openai", proxy: true });
  proxied.config.proxy.https = { type: "http", host: "127.0.0.1", port: 17891 };
  await service.enrich(native(), proxied); assert.equal(calls, 3);
});

test("并发调用共享目录请求，单方取消及时返回且不取消其他调用", async () => {
  let finish!: (value: typeof catalog) => void;
  let calls = 0;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const service = new ModelsDevCatalog(async () => { calls++; notifyStarted(); return new Promise(resolve => { finish = resolve; }); });
  const ctx = input();
  const controller = new AbortController();
  const canceled = service.enrich(native(), { ...ctx, abortSignal: controller.signal });
  const healthy = service.enrich(native(), ctx);
  await started;
  controller.abort(new Error("调用取消"));
  await assert.rejects(canceled, /调用取消/);
  assert.equal(calls, 1);
  finish(catalog);
  const result = await healthy;
  if (result.kind !== "ok") return assert.fail("unexpected");
  assert.equal(result.models.length, 2);
  const alreadyCanceled = new AbortController(); alreadyCanceled.abort(new Error("预取消"));
  await assert.rejects(service.enrich(native(), { ...input(), abortSignal: alreadyCanceled.signal }), /预取消/);
});

test("原生清单成功后内部预算耗尽仍返回原生结果，不中止其他调用的共享补齐", async t => {
  const shortDeadline = new AbortController(), longDeadline = new AbortController(), metadataDeadline = new AbortController();
  const timeoutDelays: number[] = [];
  t.mock.method(AbortSignal, "timeout", (delay: number) => {
    timeoutDelays.push(delay);
    if (delay === 100) return shortDeadline.signal;
    if (delay === 1000) return longDeadline.signal;
    if (delay === 5000) return metadataDeadline.signal;
    throw new Error(`意外超时配置 ${delay}`);
  });
  let release!: () => void, started!: () => void, metadataCalls = 0;
  const metadataStarted = new Promise<void>(resolve => { started = resolve; });
  setFetchImplementationForTests(async url => {
    if (url !== MODELS_DEV_URL) return Response.json({ data: [{ id: "chat" }] });
    metadataCalls++;
    started();
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json(catalog);
  });
  try {
    const ctx = input();
    const short = listProviderModelSlots({ ...ctx, fetchTimeoutMs: 100 });
    const long = listProviderModelSlots({ ...ctx, fetchTimeoutMs: 1000 });
    await metadataStarted;
    shortDeadline.abort(new DOMException("内部预算耗尽", "TimeoutError"));
    const result = await short;
    if (result.kind !== "ok") return assert.fail("unexpected");
    assert.equal(result.models.length, 1);
    assert.deepEqual(result.models[0]!.profile, {});
    assert.match(result.warnings[0]!, /补齐等待超时/);
    assert.equal(metadataDeadline.signal.aborted, false);
    release();
    const enriched = await long;
    if (enriched.kind !== "ok") return assert.fail("unexpected");
    assert.ok(enriched.models[0]!.profile.chat);
    assert.equal(metadataCalls, 1);
    assert.equal(timeoutDelays.filter(delay => delay === 100).length, 1);
    assert.equal(timeoutDelays.filter(delay => delay === 1000).length, 1);
  } finally { setFetchImplementationForTests(null); }
});

test("原生清单成功后外部取消仍抛出原始原因，共享补齐可继续复用", async () => {
  let release!: () => void, started!: () => void;
  let metadataSignal: AbortSignal | null | undefined;
  const metadataStarted = new Promise<void>(resolve => { started = resolve; });
  setFetchImplementationForTests(async (url, init) => {
    if (url !== MODELS_DEV_URL) return Response.json({ data: [{ id: "chat" }] });
    metadataSignal = init?.signal;
    started();
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json(catalog);
  });
  try {
    const ctx = input(), caller = new AbortController();
    const pending = listProviderModelSlots({ ...ctx, abortSignal: caller.signal });
    await metadataStarted;
    const reason = new Error("用户取消模型清单");
    caller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(metadataSignal?.aborted, false);
    release();
    const result = await listProviderModelSlots(ctx);
    if (result.kind !== "ok") return assert.fail("unexpected");
    assert.ok(result.models[0]!.profile.chat);
  } finally { setFetchImplementationForTests(null); }
});

test("超过四个并发目录请求完成后收缩缓存，期间仍合并同路径请求", async () => {
  const contexts = Array.from({ length: 6 }, () => input());
  const releases = new Map<string, () => void>();
  let calls = 0, started!: () => void;
  const allStarted = new Promise<void>(resolve => { started = resolve; });
  const service = new ModelsDevCatalog(async ctx => {
    calls++;
    if (calls > contexts.length) return catalog;
    const pending = new Promise<typeof catalog>(resolve => {
      releases.set(ctx.config.dataDir, () => resolve(catalog));
    });
    if (releases.size === contexts.length) started();
    return pending;
  });
  const pending = contexts.map(ctx => service.enrich(native(), ctx));
  await allStarted;
  const shared = service.enrich(native(), contexts[0]!);
  assert.equal(calls, 6);
  // 先完成的两条路径应在其余请求仍在途时驱逐；剩余四条可以留在内存。
  for (let i = 0; i < 2; i++) {
    releases.get(contexts[i]!.config.dataDir)!();
    await pending[i];
  }
  for (const ctx of contexts.slice(2)) releases.get(ctx.config.dataDir)!();
  await Promise.all([...pending, shared]);
  await rm(join(contexts[0]!.config.dataDir, "cache", "models-dev"), { recursive: true, force: true });
  await service.enrich(native(), contexts[0]!);
  assert.equal(calls, 7, "已驱逐路径的磁盘缓存也删除后应重新获取");
  await service.enrich(native(), contexts[5]!);
  assert.equal(calls, 7, "保留路径继续复用缓存");
});

test("原生清单失败或不支持时，不以公共目录冒充可用模型", async () => {
  let calls = 0;
  setFetchImplementationForTests(async () => { calls++; return new Response("", { status: 401 }); });
  try {
    await assert.rejects(listProviderModelSlots(input()), /401/);
    assert.equal(calls, 1);
    const result = await listProviderModelSlots(input({ type: "vertex", projectId: "synthetic-project" }));
    assert.equal(result.kind, "unsupported"); assert.equal(calls, 1);
  } finally { setFetchImplementationForTests(null); }
});


test("本地缓存跨服务重建复用，严格按最初获取时间一小时到期", async () => {
  let now = 1000, calls = 0;
  const ctx = input();
  const fetch = async () => { calls++; return catalog; };
  await new ModelsDevCatalog(fetch, () => now).enrich(native(), ctx);
  const directory = join(ctx.config.dataDir, "cache", "models-dev");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^[a-f0-9]{64}\.json$/);
  const file = join(directory, files[0]!);
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.fetchedAt, 1000);
  assert.deepEqual(stored.catalog.openai.models.chat, chat);
  now += 60 * 60 * 1000 - 1;
  const service = new ModelsDevCatalog(fetch, () => now);
  const cached = await service.enrich(native(), ctx);
  assert.equal(calls, 1);
  if (cached.kind !== "ok") return assert.fail("unexpected");
  assert.equal(cached.models.length, 2);
  assert.equal(JSON.parse(await readFile(file, "utf8")).fetchedAt, 1000);
  now++;
  await service.enrich(native(), ctx);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await readFile(file, "utf8")).fetchedAt, now);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), []);
});

test("服务重启后目录请求失败，仍能使用已过期的磁盘缓存并提示", async () => {
  let now = 1000;
  const ctx = input();
  await new ModelsDevCatalog(async () => catalog, () => now).enrich(native(), ctx);
  now += 60 * 60 * 1000;
  const result = await new ModelsDevCatalog(async () => { throw new Error("offline"); }, () => now).enrich(native(), ctx);
  if (result.kind !== "ok") return assert.fail("unexpected");
  assert.equal(result.models.length, 2);
  assert.match(result.warnings[0]!, /缓存/);
});

test("损坏及未来时间的本地缓存重新拉取，磁盘不可写不丢弃成功结果", async () => {
  let calls = 0;
  const ctx = input();
  const fetch = async () => { calls++; return catalog; };
  await new ModelsDevCatalog(fetch, () => 1000).enrich(native(), ctx);
  const directory = join(ctx.config.dataDir, "cache", "models-dev");
  const file = join(directory, (await readdir(directory))[0]!);
  await writeFile(file, "{broken");
  await new ModelsDevCatalog(fetch, () => 1000).enrich(native(), ctx);
  assert.equal(calls, 2);
  await writeFile(file, JSON.stringify({ fetchedAt: 2000, catalog }));
  await new ModelsDevCatalog(fetch, () => 1000).enrich(native(), ctx);
  assert.equal(calls, 3);
  const blocked = input();
  const marker = join(blocked.config.dataDir, "not-a-directory");
  await writeFile(marker, "blocked");
  blocked.config.dataDir = marker;
  const result = await new ModelsDevCatalog(fetch, () => 1000).enrich(native(), blocked);
  if (result.kind !== "ok") return assert.fail("unexpected");
  assert.equal(result.models.length, 2);
  assert.match(result.warnings[0]!, /本地缓存写入失败/);
});

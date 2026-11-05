import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { test } from "node:test";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createTempDir } from "../helpers/temp-paths.ts";
import { ContentSafetyService } from "../../src/contentSafety/contentSafetyService.ts";
import { contentSafetyHashText } from "../../src/contentSafety/contentSafetyHash.ts";
import { ContentSafetyStore } from "../../src/contentSafety/contentSafetyStore.ts";
import { buildTag, parseProtocolLine } from "../../src/utils/structuredEnvelope.ts";

function createConfig() {
  return createTestAppConfig({
    contentSafety: {
      enabled: true,
      provider: "keyword",
      config: {
        blockedTextKeywords: ["违规词"],
        blockedMediaNameKeywords: ["blocked"]
      },
      profiles: {
        preLlm: {
          text: {
            action: "replace_in_projection"
          },
          image: {
            action: "hide_from_projection_and_mark"
          },
          emoji: {
            action: "hide_from_projection_and_mark"
          },
          audio: {
            action: "mark_unavailable"
          }
        }
      },
      routes: {
        prompt: {
          preLlm: "preLlm"
        }
      }
    }
  });
}

function hasContentSafetyEnvelope(text: string): boolean {
  return String(text).replace(/\r\n/g, "\n").split("\n").some((line) => {
    const parsed = parseProtocolLine(line);
    return parsed?.tag === "envelope" && parsed.attrs.title === "内容安全";
  });
}

async function createHarness(config = createConfig(), files?: ConstructorParameters<typeof ContentSafetyService>[3]) {
  const dataDir = createTempDir("content-safety-service");
  await mkdir(dataDir, { recursive: true });
  const store = new ContentSafetyStore(dataDir, pino({ level: "silent" }));
  await store.init();
  const service = new ContentSafetyService(
    config,
    pino({ level: "silent" }),
    store,
    files ?? {
      async getFile() {
        return null;
      },
      async resolveAbsolutePath(fileId: string) {
        return `/tmp/${fileId}`;
      }
    }
  );
  return {
    dataDir,
    store,
    service,
    cleanup: async () => rm(dataDir, { recursive: true, force: true })
  };
}

test("prompt projection blocks unsafe batch text while preserving raw text in audit", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:p:test",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{ text: "这是一段违规词测试", userId: "user_internal" }]
    });

    assert.equal(hasContentSafetyEnvelope(result.batchMessages[0]?.text ?? ""), true);
    assert.doesNotMatch(result.batchMessages[0]?.text ?? "", /违规词测试/);
    assert.equal(result.events.length, 1);

    const record = await harness.store.getByKey(`text:v1:${contentSafetyHashText("这是一段违规词测试")}`);
    assert.ok(record);
    assert.equal(record.originalText, "这是一段违规词测试");
    assert.equal(record.decision, "block");
  } finally {
    await harness.cleanup();
  }
});

test("prompt text messages are moderated as groups and allow results are cached without audit noise", async () => {
  const config = createTestAppConfig({
    contentSafety: {
      enabled: true,
      textBatch: {
        maxMessages: 3
      },
      provider: "keyword",
      config: {
        blockedTextKeywords: ["违规词"]
      },
      profiles: {
        preLlm: {
          text: {
            action: "replace_in_projection"
          }
        }
      }
    }
  });
  const harness = await createHarness(config);
  try {
    const inputs = ["第一条正常消息", "第二条正常消息", "第三条正常消息"];
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: inputs.map((text) => ({ text, userId: "user_internal" }))
    });

    assert.deepEqual(result.batchMessages.map((item) => item.text), inputs);
    assert.deepEqual(result.events, []);

    for (const text of inputs) {
      const record = await harness.store.getByKey(`text:v1:${contentSafetyHashText(text)}`);
      assert.ok(record);
      assert.equal(record.decision, "allow");
      assert.equal(record.originalText, undefined);
    }
    assert.deepEqual(await harness.store.listBySessionId("qqbot:g:100"), []);
  } finally {
    await harness.cleanup();
  }
});

test("blocked prompt group falls back to per-message moderation to locate unsafe messages", async () => {
  const config = createTestAppConfig({
    contentSafety: {
      enabled: true,
      textBatch: {
        maxMessages: 3
      },
      provider: "keyword",
      config: {
        blockedTextKeywords: ["违规词"]
      },
      profiles: {
        preLlm: {
          text: {
            action: "replace_in_projection"
          }
        }
      }
    }
  });
  const harness = await createHarness(config);
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [
        { text: "正常一", userId: "u1" },
        { text: "这里有违规词", userId: "u2" },
        { text: "正常二", userId: "u3" }
      ]
    });

    assert.equal(result.batchMessages[0]?.text, "正常一");
    assert.equal(hasContentSafetyEnvelope(result.batchMessages[1]?.text ?? ""), true);
    assert.equal(result.batchMessages[2]?.text, "正常二");
    assert.equal(result.events.length, 1);

    const blocked = await harness.store.getByKey(`text:v1:${contentSafetyHashText("这里有违规词")}`);
    assert.ok(blocked);
    assert.equal(blocked.decision, "block");
    assert.equal(blocked.originalText, "这里有违规词");
  } finally {
    await harness.cleanup();
  }
});

test("cached blocked text is projected before provider grouping", async () => {
  const harness = await createHarness();
  try {
    const first = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{ text: "重复违规词", userId: "u1" }]
    });
    const second = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{ text: "重复违规词", userId: "u1" }]
    });

    assert.equal(hasContentSafetyEnvelope(first.batchMessages[0]?.text ?? ""), true);
    assert.equal(hasContentSafetyEnvelope(second.batchMessages[0]?.text ?? ""), true);
    assert.equal(second.events[0]?.auditKey, `text:v1:${contentSafetyHashText("重复违规词")}`);
  } finally {
    await harness.cleanup();
  }
});

test("cached blocked text writes an audit record for a new session", async () => {
  const harness = await createHarness();
  try {
    await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:first",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{ text: "跨会话违规词", userId: "u1" }]
    });
    const second = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:second",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{ text: "跨会话违规词", userId: "u2" }]
    });

    const globalKey = `text:v1:${contentSafetyHashText("跨会话违规词")}`;
    assert.equal(second.events[0]?.auditKey, `${globalKey}:session:qqbot:g:second`);
    const secondRecords = await harness.store.listBySessionId("qqbot:g:second");
    assert.equal(secondRecords.length, 1);
    assert.equal(secondRecords[0]?.key, `${globalKey}:session:qqbot:g:second`);
  } finally {
    await harness.cleanup();
  }
});

test("projectLlmMessages moderates replay-style user messages", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.projectLlmMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt_replay",
      messages: [
        { role: "system", content: "系统违规词不重审" },
        { role: "user", content: "replay 违规词" },
        { role: "tool", content: "tool 违规词" },
        { role: "assistant", content: "助手违规词不重审" }
      ]
    });

    assert.equal(result.messages[0]?.content, "系统违规词不重审");
    assert.equal(hasContentSafetyEnvelope(String(result.messages[1]?.content ?? "")), true);
    assert.equal(hasContentSafetyEnvelope(String(result.messages[2]?.content ?? "")), true);
    assert.equal(result.messages[3]?.content, "助手违规词不重审");
    assert.equal(result.events.length, 2);
  } finally {
    await harness.cleanup();
  }
});

test("projectLlmMessages moderates multimodal content parts", async () => {
  const harness = await createHarness(createTestAppConfig({
    contentSafety: {
      enabled: true,
      provider: "keyword",
      config: {
        blockedTextKeywords: ["违规词"],
        blockedMediaNameKeywords: ["content_part"]
      },
      profiles: {
        preLlm: {
          text: {
            action: "replace_in_projection"
          },
          image: {
            action: "hide_from_projection_and_mark"
          },
          emoji: {
            action: "hide_from_projection_and_mark"
          },
          audio: {
            action: "mark_unavailable"
          }
        }
      },
      routes: {
        prompt: {
          preLlm: "preLlm"
        }
      }
    }
  }));
  try {
    const result = await harness.service.projectLlmMessages({
      sessionId: "qqbot:g:100",
      source: "provider_call_preflight",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "part 违规词" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
          { type: "input_audio", input_audio: { data: "AAAA", format: "mp3", mimeType: "audio/mpeg" } }
        ]
      }]
    });

    const content = result.messages[0]?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.every((part) => part.type === "text"), true);
    assert.equal(hasContentSafetyEnvelope(content.map((part) => part.type === "text" ? part.text : "").join("\n")), true);
    assert.equal(result.events.length, 4);
  } finally {
    await harness.cleanup();
  }
});

test("prompt projection checks special segment summaries", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{
        text: "",
        userId: "u1",
        specialSegments: [{ type: "json", summary: "卡片里有违规词" }]
      }]
    });

    assert.equal(hasContentSafetyEnvelope(result.batchMessages[0]?.specialSegments?.[0]?.summary ?? ""), true);
    assert.equal(result.events.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("prompt projection hides blocked audio before native audio prompt rendering", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{
        text: "听这个",
        userId: "u1",
        audioIds: ["aud_blocked"],
        audioSources: ["blocked.wav"]
      }]
    });

    assert.deepEqual(result.batchMessages[0]?.audioIds, []);
    assert.deepEqual(result.batchMessages[0]?.audioSources, []);
    assert.equal(hasContentSafetyEnvelope(result.batchMessages[0]?.text ?? ""), true);
    assert.equal(result.events[0]?.subjectKind, "audio");
  } finally {
    await harness.cleanup();
  }
});

test("prompt projection also checks user history messages", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "scheduled_prompt",
      recentMessages: [
        { role: "assistant", content: "助手历史违规词不重审", timestampMs: 1 },
        { role: "user", content: "用户历史违规词", timestampMs: 2 }
      ],
      batchMessages: []
    });

    assert.equal(result.recentMessages[0]?.content, "助手历史违规词不重审");
    assert.equal(hasContentSafetyEnvelope(result.recentMessages[1]?.content ?? ""), true);
  } finally {
    await harness.cleanup();
  }
});

test("prompt projection hides blocked media before prompt rendering", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [{
        role: "user",
        content: ["历史图", buildTag("ref", { kind: "image", image_id: "blocked_history" })].join("\n"),
        timestampMs: 1
      }],
      batchMessages: [{
        text: "看图",
        userId: "u1",
        imageIds: ["blocked_image"],
        attachments: [{
          fileId: "blocked_image",
          kind: "image",
          source: "chat_message",
          sourceName: "blocked-image.png",
          mimeType: "image/png",
          semanticKind: "image"
        }]
      }]
    });

    assert.equal(hasContentSafetyEnvelope(result.recentMessages[0]?.content ?? ""), true);
    assert.doesNotMatch(result.recentMessages[0]?.content ?? "", /image_id="blocked_history"/);
    assert.equal(hasContentSafetyEnvelope(result.batchMessages[0]?.text ?? ""), true);
    assert.deepEqual(result.batchMessages[0]?.imageIds, []);
    assert.deepEqual(result.batchMessages[0]?.attachments, []);
  } finally {
    await harness.cleanup();
  }
});

test("prompt projection moderates structured content parts", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{
        text: "原始字段不应作为结构化 prompt 主体",
        userId: "u1",
        imageIds: ["blocked_image"],
        attachments: [{
          fileId: "blocked_image",
          kind: "image",
          source: "chat_message",
          sourceName: "blocked-image.png",
          mimeType: "image/png",
          semanticKind: "image"
        }],
        contentParts: [
          { kind: "text", text: "这里有违规词" },
          { kind: "image", fileId: "blocked_image", sourceName: "blocked-image.png", mimeType: "image/png" },
          { kind: "special", segmentType: "json", summary: "卡片违规词" }
        ]
      }]
    });

    const parts = result.batchMessages[0]?.contentParts ?? [];
    assert.equal(hasContentSafetyEnvelope(parts.find((part) => part.kind === "text")?.text ?? ""), true);
    assert.equal(parts.some((part) => part.kind === "image"), false);
    assert.equal(parts.filter((part) => part.kind === "text").length, 2);
    assert.equal(hasContentSafetyEnvelope(parts.find((part) => part.kind === "special")?.summary ?? ""), true);
    assert.deepEqual(result.batchMessages[0]?.imageIds, []);
    assert.deepEqual(result.batchMessages[0]?.attachments, []);
    assert.equal(result.events.length, 3);
  } finally {
    await harness.cleanup();
  }
});

test("prompt projection appends media markers to text-only content parts", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:g:100",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{
        text: "看图",
        userId: "u1",
        imageIds: ["blocked_image"],
        attachments: [{
          fileId: "blocked_image",
          kind: "image",
          source: "chat_message",
          sourceName: "blocked-image.png",
          mimeType: "image/png",
          semanticKind: "image"
        }],
        contentParts: [
          { kind: "text", text: "看图" }
        ]
      }]
    });

    const parts = result.batchMessages[0]?.contentParts ?? [];
    assert.deepEqual(parts[0], { kind: "text", text: "看图" });
    assert.equal(hasContentSafetyEnvelope(parts[1]?.kind === "text" ? parts[1].text : ""), true);
    assert.deepEqual(result.batchMessages[0]?.imageIds, []);
    assert.deepEqual(result.batchMessages[0]?.attachments, []);
    assert.equal(result.events.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("action allow bypasses risky provider result", async () => {
  const config = createTestAppConfig({
    contentSafety: {
      enabled: true,
      provider: "keyword",
      config: {
        blockedTextKeywords: ["违规词"]
      },
      profiles: {
        preLlm: {
          text: {
            action: "allow"
          }
        }
      }
    }
  });
  const harness = await createHarness(config);
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:p:test",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{ text: "这是一段违规词测试", userId: "user_internal" }]
    });
    assert.equal(result.batchMessages[0]?.text, "这是一段违规词测试");
    assert.deepEqual(result.events, []);
  } finally {
    await harness.cleanup();
  }
});

test("action mark keeps original text and appends audit marker", async () => {
  const config = createTestAppConfig({
    contentSafety: {
      enabled: true,
      provider: "keyword",
      config: {
        blockedTextKeywords: ["违规词"]
      },
      profiles: {
        preLlm: {
          text: {
            action: "mark"
          }
        }
      }
    }
  });
  const harness = await createHarness(config);
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:p:test",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{ text: "这是一段违规词测试", userId: "user_internal" }]
    });
    assert.match(result.batchMessages[0]?.text ?? "", /违规词测试/);
    assert.equal(hasContentSafetyEnvelope(result.batchMessages[0]?.text ?? ""), true);
    assert.equal(result.events.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("enabled content safety without configured credentials allows normal projection", async () => {
  const harness = await createHarness(createTestAppConfig({
    contentSafety: {
      enabled: true,
      profiles: {
        preLlm: {}
      }
    }
  }));
  try {
    const result = await harness.service.projectPromptMessages({
      sessionId: "qqbot:p:test",
      source: "chat_prompt",
      recentMessages: [],
      batchMessages: [{ text: "正常消息", userId: "user_internal" }]
    });
    assert.equal(result.batchMessages[0]?.text, "正常消息");
    assert.deepEqual(result.events, []);
  } finally {
    await harness.cleanup();
  }
});

test("provider, model and rule changes invalidate cached moderation results", async () => {
  const { withMockFetch } = await import("../helpers/llm-test-support.tsx");
  const { parseConfig } = await import("../../src/data/schema/index.ts");
  const { contentSafetyConfigSchema } = await import("../../src/config/contentSafetyConfig.ts");
  const config = createConfig();
  const keywordSettings = structuredClone(config.contentSafety.config);
  config.contentSafety = parseConfig(contentSafetyConfigSchema, { ...config.contentSafety, provider: "openai", config: { apiKey: "test-key" } });
  const harness = await createHarness(config);
  const project = () => harness.service.projectPromptMessages({ sessionId: "test", source: "test", recentMessages: [], batchMessages: [{ text: "重复违规词测试" }] });
  const allow = () => Response.json({ id: "mod", results: [{ flagged: false, categories: { violence: false }, category_scores: { violence: 0.7 } }] });
  try {
    await withMockFetch([
      { assertRequest() {}, response: allow() },
      { assertRequest() {}, response: allow() },
      { assertRequest(body: any) { assert.equal(body.model, "omni-moderation-2024-09-26"); }, response: allow() },
      { assertRequest() {}, response: allow() }
    ], async () => {
      assert.equal((await project()).events.length, 0);
      assert.equal((await project()).events.length, 0, "same policy should reuse the allow result");
      config.contentSafety = parseConfig(contentSafetyConfigSchema, { ...config.contentSafety, provider: "keyword", config: keywordSettings });
      assert.equal((await project()).events[0]?.decision, "block", "a new provider must not reuse an old allow result");
      config.contentSafety = parseConfig(contentSafetyConfigSchema, { ...config.contentSafety, provider: "openai", config: { apiKey: "test-key" } });
      assert.equal((await project()).events.length, 0, "switching back must not reuse the keyword block");
      const openai = config.contentSafety;
      if (openai.provider !== "openai") throw new Error("unexpected provider");
      openai.config.model = "omni-moderation-2024-09-26";
      assert.equal((await project()).events.length, 0);
      config.contentSafety.profiles.preLlm!.text.blockConfidenceGte = 60;
      assert.equal((await project()).events[0]?.decision, "block", "threshold changes must trigger a fresh decision");
    });
  } finally { await harness.cleanup(); }
});

test("OpenAI moderation failures respect failPolicy and never become reusable allow decisions", async () => {
  const { withMockFetch } = await import("../helpers/llm-test-support.tsx");
  const { parseConfig } = await import("../../src/data/schema/index.ts");
  const { contentSafetyConfigSchema } = await import("../../src/config/contentSafetyConfig.ts");
  const config = createConfig();
  config.contentSafety = parseConfig(contentSafetyConfigSchema, { ...config.contentSafety, provider: "openai", config: { apiKey: "test-key" } });
  const harness = await createHarness(config);
  const project = () => harness.service.projectPromptMessages({ sessionId: "test", source: "test", recentMessages: [], batchMessages: [{ text: "公开测试内容" }] });
  try {
    await withMockFetch([
      { assertRequest() {}, response: new Response("upstream-private-data", { status: 500 }) },
      { assertRequest() {}, response: new Response("upstream-private-data", { status: 500 }) },
      { assertRequest() {}, response: new Response("upstream-private-data", { status: 500 }) }
    ], async () => {
      assert.equal((await project()).events.length, 0);
      assert.equal((await project()).events.length, 0, "failure allow must be retried next time");
      config.contentSafety.failPolicy = "mark";
      const marked = await project();
      assert.equal(marked.events[0]?.decision, "review");
      assert.doesNotMatch(marked.batchMessages[0]!.text, /upstream-private-data|公开测试内容/);
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(harness.service.projectPromptMessages({ sessionId: "abort", source: "test", recentMessages: [], batchMessages: [{ text: "另一个测试" }], abortSignal: controller.signal }));
  } finally { await harness.cleanup(); }
});

test("media blocks are rechecked after policy changes and tool guards reuse only current decisions", async () => {
  const config = createConfig();
  const harness = await createHarness(config, {
    async getFile(fileId) { return {
      fileId, fileRef: fileId, kind: "image", origin: "chat_message", chatFilePath: "/tmp/image.png",
      sourceName: fileId, mimeType: "image/png", sizeBytes: 1, createdAtMs: 1, sourceContext: {}, caption: null
    }; },
    async resolveAbsolutePath() { return "/tmp/image.png"; }
  });
  const project = () => harness.service.projectPromptMessages({ sessionId: "test", source: "test", recentMessages: [], batchMessages: [{ text: "", imageIds: ["blocked-image"] }] });
  try {
    assert.equal((await project()).events[0]?.decision, "block");
    assert.notEqual(await harness.service.guardChatFileForLlm("blocked-image"), "allow");
    const keyword = config.contentSafety;
    if (keyword.provider !== "keyword") throw new Error("unexpected provider");
    keyword.config.blockedMediaNameKeywords = [];
    assert.equal(await harness.service.guardChatFileForLlm("blocked-image"), "allow", "old media blocks must not survive a policy switch");
    assert.equal((await project()).events.length, 0);
  } finally { await harness.cleanup(); }
});

test("missing credentials honor mark policy, while allow rules skip external moderation", async () => {
  const { parseConfig } = await import("../../src/data/schema/index.ts");
  const { contentSafetyConfigSchema } = await import("../../src/config/contentSafetyConfig.ts");
  const config = createConfig();
  config.contentSafety = parseConfig(contentSafetyConfigSchema, { ...config.contentSafety, provider: "openai", config: { apiKeyEnv: "MISSING_SMOKE_CREDENTIAL" }, failPolicy: "mark" });
  const harness = await createHarness(config);
  const project = () => harness.service.projectPromptMessages({ sessionId: "test", source: "test", recentMessages: [], batchMessages: [{ text: "公开测试" }] });
  try {
    assert.equal((await project()).events[0]?.decision, "review");
    config.contentSafety.profiles.preLlm!.text.action = "allow";
    assert.equal((await project()).events.length, 0);
  } finally { await harness.cleanup(); }
});

test("in-flight moderation uses its original model and rule snapshot without poisoning the next policy's cache", async () => {
  const { withMockFetch } = await import("../helpers/llm-test-support.tsx");
  const { parseConfig } = await import("../../src/data/schema/index.ts");
  const { contentSafetyConfigSchema } = await import("../../src/config/contentSafetyConfig.ts");
  const config = createConfig();
  config.contentSafety = parseConfig(contentSafetyConfigSchema, { ...config.contentSafety, provider: "openai", config: { apiKey: "test-key" } });
  const harness = await createHarness(config);
  const project = () => harness.service.projectPromptMessages({ sessionId: "test", source: "test", recentMessages: [], batchMessages: [{ text: "相同的公开测试" }] });
  const allow = () => Response.json({ id: "mod", results: [{ flagged: false, categories: { violence: false }, category_scores: { violence: 0.7 } }] });
  try {
    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.model, "omni-moderation-latest");
          const settings = config.contentSafety;
          if (settings.provider !== "openai") throw new Error("unexpected provider");
          settings.config.model = "omni-moderation-2024-09-26";
          config.contentSafety.profiles.preLlm!.text.blockConfidenceGte = 60;
        }, response: allow()
      },
      { assertRequest(body: any) { assert.equal(body.model, "omni-moderation-2024-09-26"); }, response: allow() }
    ], async () => {
      assert.equal((await project()).events.length, 0, "the original request must use its original thresholds");
      assert.equal((await project()).events[0]?.decision, "block", "the new policy must request its own result");
    });
  } finally { await harness.cleanup(); }
});

test("tool media guards do not submit non-image files for image moderation", async () => {
  const config = createConfig();
  config.contentSafety.failPolicy = "mark";
  const { parseConfig } = await import("../../src/data/schema/index.ts");
  const { contentSafetyConfigSchema } = await import("../../src/config/contentSafetyConfig.ts");
  config.contentSafety = parseConfig(contentSafetyConfigSchema, { ...config.contentSafety, provider: "openai", config: { apiKey: "test-key" } });
  const { withMockFetch } = await import("../helpers/llm-test-support.tsx");
  const harness = await createHarness(config, {
    async getFile(fileId) { return {
      fileId, fileRef: fileId, kind: fileId === "audio" ? "audio" : "file", origin: "chat_message", chatFilePath: "/tmp/not-an-image",
      sourceName: fileId, mimeType: fileId === "audio" ? "audio/mpeg" : "application/pdf", sizeBytes: 1, createdAtMs: 1, sourceContext: {}, caption: null
    }; },
    async resolveAbsolutePath() { throw new Error("non-image files must not be opened"); }
  });
  try {
    await withMockFetch([], async () => {
      assert.equal(await harness.service.guardChatFileForLlm("pdf"), "allow");
      assert.equal(await harness.service.guardChatFileForLlm("audio"), "allow");
    });
  } finally { await harness.cleanup(); }
});

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { test } from "node:test";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createTempDir } from "../helpers/temp-paths.ts";
import { ContentSafetyService } from "../../src/contentSafety/contentSafetyService.ts";
import { contentSafetyHashText } from "../../src/contentSafety/contentSafetyHash.ts";
import { ContentSafetyStore } from "../../src/contentSafety/contentSafetyStore.ts";

function createConfig() {
  return createTestAppConfig({
    contentSafety: {
      enabled: true,
      providers: {
        localKeyword: {
          type: "keyword",
          enabled: true,
          blockedTextKeywords: ["违规词"],
          blockedMediaNameKeywords: ["blocked"]
        }
      },
      profiles: {
        preLlm: {
          text: {
            provider: "localKeyword",
            action: "replace_in_projection"
          },
          image: {
            provider: "localKeyword",
            action: "hide_from_projection_and_mark"
          },
          emoji: {
            provider: "localKeyword",
            action: "hide_from_projection_and_mark"
          },
          audio: {
            provider: "localKeyword",
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

async function createHarness(config = createConfig()) {
  const dataDir = createTempDir("content-safety-service");
  await mkdir(dataDir, { recursive: true });
  const store = new ContentSafetyStore(dataDir, pino({ level: "silent" }));
  await store.init();
  const service = new ContentSafetyService(
    config,
    pino({ level: "silent" }),
    store,
    {
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

    assert.match(result.batchMessages[0]?.text ?? "", /⟦内容安全/);
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
      providers: {
        localKeyword: {
          type: "keyword",
          enabled: true,
          blockedTextKeywords: ["违规词"]
        }
      },
      profiles: {
        preLlm: {
          text: {
            provider: "localKeyword",
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
      providers: {
        localKeyword: {
          type: "keyword",
          enabled: true,
          blockedTextKeywords: ["违规词"]
        }
      },
      profiles: {
        preLlm: {
          text: {
            provider: "localKeyword",
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
    assert.match(result.batchMessages[1]?.text ?? "", /⟦内容安全/);
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

    assert.match(first.batchMessages[0]?.text ?? "", /⟦内容安全/);
    assert.match(second.batchMessages[0]?.text ?? "", /⟦内容安全/);
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
    assert.match(String(result.messages[1]?.content ?? ""), /⟦内容安全/);
    assert.match(String(result.messages[2]?.content ?? ""), /⟦内容安全/);
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
      providers: {
        localKeyword: {
          type: "keyword",
          enabled: true,
          blockedTextKeywords: ["违规词"],
          blockedMediaNameKeywords: ["content_part"]
        }
      },
      profiles: {
        preLlm: {
          text: {
            provider: "localKeyword",
            action: "replace_in_projection"
          },
          image: {
            provider: "localKeyword",
            action: "hide_from_projection_and_mark"
          },
          emoji: {
            provider: "localKeyword",
            action: "hide_from_projection_and_mark"
          },
          audio: {
            provider: "localKeyword",
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
          { type: "input_audio", input_audio: { data: "AAAA", format: "mp3", mimeType: "audio/mpeg" } }
        ]
      }]
    });

    const content = result.messages[0]?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.every((part) => part.type === "text"), true);
    assert.match(content.map((part) => part.type === "text" ? part.text : "").join("\n"), /⟦内容安全/);
    assert.equal(result.events.length, 3);
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

    assert.match(result.batchMessages[0]?.specialSegments?.[0]?.summary ?? "", /⟦内容安全/);
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
    assert.match(result.batchMessages[0]?.text ?? "", /⟦内容安全/);
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
    assert.match(result.recentMessages[1]?.content ?? "", /⟦内容安全/);
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
        content: "历史图 ⟦ref kind=\"image\" image_id=\"blocked_history\"⟧",
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

    assert.match(result.recentMessages[0]?.content ?? "", /⟦内容安全/);
    assert.doesNotMatch(result.recentMessages[0]?.content ?? "", /image_id="blocked_history"/);
    assert.match(result.batchMessages[0]?.text ?? "", /⟦内容安全/);
    assert.deepEqual(result.batchMessages[0]?.imageIds, []);
    assert.deepEqual(result.batchMessages[0]?.attachments, []);
  } finally {
    await harness.cleanup();
  }
});

test("action allow bypasses risky provider result", async () => {
  const config = createTestAppConfig({
    contentSafety: {
      enabled: true,
      providers: {
        localKeyword: {
          type: "keyword",
          enabled: true,
          blockedTextKeywords: ["违规词"]
        }
      },
      profiles: {
        preLlm: {
          text: {
            provider: "localKeyword",
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
      providers: {
        localKeyword: {
          type: "keyword",
          enabled: true,
          blockedTextKeywords: ["违规词"]
        }
      },
      profiles: {
        preLlm: {
          text: {
            provider: "localKeyword",
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
    assert.match(result.batchMessages[0]?.text ?? "", /⟦内容安全/);
    assert.equal(result.events.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("enabled content safety without configured providers allows normal projection", async () => {
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

import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationPromptBuilder } from "../../src/app/generation/generationPromptBuilder.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { hasPromptSection, readPromptSystemText } from "../helpers/prompt-fixtures.tsx";
import { buildTag } from "../../src/utils/structuredEnvelope.ts";

type TestPromptHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  timestampMs?: number | null;
};

type TestPromptBatchMessage = {
  text: string;
};

function createMinimalPromptBuilderDeps(overrides: Record<string, unknown> = {}) {
  return {
    config: createTestAppConfig(),
    oneBotClient: {} as any,
    audioStore: {} as any,
    audioTranscriber: {
      async ensureReady() {
        return new Map();
      },
      async transcribeMany() {
        return [];
      }
    } as any,
    npcDirectory: {
      listProfiles() {
        return [];
      }
    } as any,
    browserService: {
      async listPages() {
        return { pages: [] };
      }
    } as any,
    localFileService: {} as any,
    chatFileStore: {} as any,
    downloadRuntime: { list() { return []; } } as any,
    mediaVisionService: {
      async prepareFilesForModel() {
        return [];
      }
    } as any,
    mediaCaptionService: {
      async ensureReady() {
        return new Map();
      }
    } as any,
    globalRuleStore: {
      async getAll() {
        return [];
      }
    } as any,
    toolsetRuleStore: {
      async getAll() {
        return [];
      }
    } as any,
    scenarioHostStateStore: {
      async ensure() {
        throw new Error("should not load scenario state");
      }
    } as any,
    shellRuntime: {
      async listSessionResources() {
        return [];
      }
    } as any,
    setupStore: {
      describeMissingFields() {
        return [];
      }
    } as any,
    ...overrides
  } as any;
}

function createActiveTaskTracker() {
  return {
    version: 1 as const,
    primary: {
      taskId: "task-1",
      status: "active" as const,
      objective: "处理后台任务",
      done: [],
      next: ["继续处理"],
      blockers: [],
      importantToolRefs: [],
      createdAtMs: 1,
      updatedAtMs: 2
    },
    parked: [],
    evidence: []
  };
}

  test("setup prompt prepares image visuals when vision is enabled", async () => {
    const capturedImageIdCalls: string[][] = [];
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig({
        llm: {
          enabled: true,
          models: {
            main: {
              supportsVision: true
            }
          }
        }
      }),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel(imageIds: string[]) {
          capturedImageIdCalls.push(imageIds);
          return [{
            fileId: imageIds[0] ?? "file_1",
            inputUrl: "data:image/png;base64,AAAA",
            kind: "image",
            transport: "data_url",
            animated: false,
            durationMs: null,
            sampledFrameCount: null
          }];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("should not load scenario_host state in setup prompt");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildSetupPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      persona: { prompt: "" } as any,
      phase: "setup",
      historyForPrompt: [],
      internalTranscript: [],
      currentUser: null,
      participantProfiles: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "看这张图",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: ["img-1"],
        emojiIds: [],
        attachments: [{
          fileId: "file_1",
          kind: "image",
          source: "chat_message",
          sourceName: "a.png",
          mimeType: "image/png",
          semanticKind: "image"
        }],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    assert.deepEqual(capturedImageIdCalls, [["file_1"], []]);
    const content = result.promptMessages[1]?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.some((part) => part.type === "image_url"), true);
  });

  test("chat prompt renders bounded asset handles for non-visual file attachments in attachment order", async () => {
    const longSourceName = `evil\n<asset/>-${"x".repeat(240)}.pdf`;
    const requestedFileIds: string[][] = [];
    const filesById = new Map(Array.from({ length: 7 }, (_, index) => {
      const number = index + 1;
      const fileId = `file_doc_${number}`;
      const fileRef = number === 1
        ? "first.pdf"
        : number === 2
          ? "second.pdf"
          : `doc-${number}.pdf`;
      return [fileId, {
        fileId,
        fileRef,
        kind: "file",
        origin: "chat_message",
        chatFilePath: `chat-files/media/${fileRef}`,
        sourceName: number === 1 ? longSourceName : fileRef,
        mimeType: "application/pdf",
        sizeBytes: 1234 + number,
        createdAtMs: number,
        sourceContext: {},
        caption: null
      }];
    }));
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps({
      chatFileStore: {
        async getMany(fileIds: string[]) {
          requestedFileIds.push(fileIds);
          return [...fileIds]
            .reverse()
            .map((fileId) => filesById.get(fileId))
            .filter((file): file is NonNullable<typeof file> => Boolean(file));
        }
      }
    }));

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: ["asset_document_overview", "asset_document_search", "asset_document_read", "asset_document_inspect"],
      activeToolsets: [{
        id: "asset_io",
        title: "Chat file IO",
        description: "files",
        toolNames: ["asset_document_overview", "asset_document_search", "asset_document_read", "asset_document_inspect"]
      }],
      persona: {
        name: "Bot",
        temperament: "冷静",
        voiceStyle: "简洁"
      } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "看一下这个文档",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        attachments: Array.from({ length: 7 }, (_, index) => ({
          fileId: `file_doc_${index + 1}`,
          kind: "file" as const,
          source: "chat_message" as const,
          sourceName: index === 0 ? longSourceName : `doc-${index + 1}.pdf`,
          mimeType: "application/pdf"
        })),
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    const rendered = result.promptMessages.map((message) => JSON.stringify(message.content)).join("\n");
    assert.deepEqual(requestedFileIds, [[
      "file_doc_1",
      "file_doc_2",
      "file_doc_3",
      "file_doc_4",
      "file_doc_5",
      "file_doc_6",
      "file_doc_7"
    ]]);
    assert.match(rendered, /附件 asset_handle/);
    assert.ok(rendered.indexOf("asset_ref=first.pdf") >= 0);
    assert.ok(rendered.indexOf("asset_ref=second.pdf") > rendered.indexOf("asset_ref=first.pdf"));
    assert.doesNotMatch(rendered, /asset_ref=doc-7\.pdf/);
    assert.match(rendered, /其余 1 个附件未展开/);
    assert.doesNotMatch(rendered, /evil\\n/);
    assert.match(rendered, /source_name=evil <asset\/>-x+/);
    assert.match(rendered, /\.\.\.\[truncated\]/);
    assert.match(rendered, /document_overview:asset_document_overview/);
    assert.match(rendered, /document_search:asset_document_search/);
  });

  test("chat prompt annotates history audio references through protocol parser", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps({
      audioTranscriber: {
        async ensureReady(audioIds: string[]) {
          return new Map(audioIds.map((audioId) => [audioId, {
            audioId,
            status: "ready",
            text: "这是听写文本"
          }]));
        }
      }
    }));

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      persona: {
        name: "Bot",
        temperament: "冷静",
        voiceStyle: "简洁"
      } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [{
        role: "user",
        content: ["听这个", buildTag("audio", { audio_id: "aud-1" })].join("\n"),
        timestampMs: Date.UTC(2026, 2, 16, 9, 12, 0)
      }],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "刚才语音说了什么",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    const rendered = result.promptMessages.map((message) => JSON.stringify(message.content)).join("\n");
    assert.match(rendered, /音频 aud-1 听写：这是听写文本/);
  });

  test("chat prompt includes stable runtime resource summaries from browser and shell", async () => {
    const browserPages = Array.from({ length: 7 }, (_, index) => ({
      resource_id: `res_browser_${index + 1}`,
      status: "active" as const,
      title: `Docs ${index + 1}`,
      description: `浏览第 ${index + 1} 个页面`,
      summary: `Docs page ${index + 1}`,
      requestedUrl: `https://example.com/docs/${index + 1}`,
      resolvedUrl: `https://example.com/docs/${index + 1}`,
      backend: "playwright" as const,
      createdAtMs: index + 1,
      lastAccessedAtMs: index + 1,
      expiresAtMs: null
    }));
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return {
            pages: browserPages
          };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      contextStore: {
        listUserPromptFacts() {
          return [{
            id: "mem_1",
            title: "输出顺序",
            content: "先给结论再展开。",
            kind: "fact",
            source: "user_explicit",
            createdAt: 1,
            updatedAt: 1
          }];
        },
        listUserFacts() {
          return [];
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("should not load scenario_host state in rp_assistant prompt");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [{
            resource_id: "res_shell_1",
            status: "active",
            command: "npm test",
            cwd: "/repo",
            shell: "/bin/bash",
            login: true,
            tty: true,
            title: "npm test @ /repo",
            description: "跑测试",
            summary: "npm test cwd=/repo",
            createdAtMs: 1,
            lastAccessedAtMs: 2,
            expiresAtMs: null
          }];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: ["terminal_list", "terminal_run", "open_page"],
      activeToolsets: [
        {
          id: "shell_runtime",
          title: "Shell 运行时",
          description: "执行与交互 shell 会话，并复用 live_resource。",
          toolNames: ["terminal_list", "terminal_run"]
        },
        {
          id: "web_research",
          title: "网页检索与浏览",
          description: "搜索网页、打开页面、交互与截图。",
          toolNames: ["open_page"]
        }
      ],
      persona: {
        name: "Bot",
        temperament: "冷静",
        voiceStyle: "简洁"
      } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "继续上次操作",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.match(system, /当前可复用 live_resource/);
    assert.match(system, /res_browser_7 \| browser \| active \| Docs 7 \| 浏览第 7 个页面/);
    assert.match(system, /res_browser_1 \| browser \| active \| Docs 1/);
    assert.match(system, /res_shell_1 \| shell \| active \| npm test @ \/repo \| 跑测试/);
  });

  test("chat prompt applies content safety projection before rendering messages", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      contentSafetyService: {
        async projectPromptMessages<
          H extends TestPromptHistoryMessage,
          B extends TestPromptBatchMessage
        >(input: {
          recentMessages: H[];
          batchMessages: B[];
        }) {
          return {
            recentMessages: input.recentMessages.map((message) => (message.role === "user"
              ? { ...message, content: "<内容安全\n类型: 内容\n状态: 已屏蔽\n>" } as H
              : message)),
            batchMessages: input.batchMessages.map((message) => ({
              ...message,
              text: "<内容安全\n类型: 内容\n状态: 已屏蔽\n>"
            } as B)),
            events: []
          };
        },
        async projectLlmMessages<T extends { messages: unknown[] }>(input: T) {
          return { ...input, events: [] };
        }
      },
      globalRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("should not load scenario state");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      persona: {
        name: "Bot",
        temperament: "冷静",
        voiceStyle: "简洁"
      } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [{ role: "user", content: "原始历史", timestampMs: 1 }],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "原始当前消息",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    const rendered = result.promptMessages.map((message) => String(message.content ?? "")).join("\n");
    assert.match(rendered, /<内容安全/);
    assert.doesNotMatch(rendered, /原始历史/);
  assert.doesNotMatch(rendered, /原始当前消息/);
  assert.match(result.debugSnapshot.currentBatch[0]?.text ?? "", /<内容安全/);
  });

  test("chat prompt applies content safety projection to provider replay messages", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps({
      contentSafetyService: {
        async projectPromptMessages<
          H extends TestPromptHistoryMessage,
          B extends TestPromptBatchMessage
        >(input: {
          recentMessages: H[];
          batchMessages: B[];
        }) {
          return { ...input, events: [] };
        },
        async projectLlmMessages(input: { messages: Array<{ role: string; content: unknown }> }) {
          return {
            messages: input.messages.map((message) => (
              message.role === "user" && typeof message.content === "string" && message.content.includes("replay-unsafe")
                ? { ...message, content: "<内容安全\n类型: 内容\n状态: 已屏蔽\n>" }
                : message
            )),
            events: []
          };
        }
      }
    }));

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      replayMessages: [{ role: "user", content: "replay-unsafe 原始 replay" }],
      persona: { name: "Bot", temperament: "", voiceStyle: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "正常当前消息",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    const rendered = result.promptMessages.map((message) => String(message.content ?? "")).join("\n");
    assert.match(rendered, /<内容安全/);
    assert.doesNotMatch(rendered, /replay-unsafe 原始 replay/);
  });

  test("chat prompt builder renders task tracker sections from generation input", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps());

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: ["terminal_run"],
      activeToolsets: [{
        id: "shell_runtime",
        title: "Shell 运行时",
        description: "执行与交互 terminal 会话，并复用 terminal resource。",
        toolNames: ["terminal_run"]
      }],
      persona: { name: "Bot", temperament: "", voiceStyle: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      taskTracker: {
        version: 1,
        primary: {
          taskId: "task-1",
          status: "active",
          objective: "验证真实 prompt builder 链路",
          done: [],
          next: ["继续跑测试"],
          blockers: [],
          importantToolRefs: [],
          createdAtMs: 1,
          updatedAtMs: 2
        },
        parked: [],
        evidence: []
      },
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "继续",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.equal(hasPromptSection(system, "task_focus"), true);
    assert.equal(hasPromptSection(system, "active_task_state"), true);
    assert.equal(hasPromptSection(system, "tool_playbooks"), true);
    assert.match(system, /目标=验证真实 prompt builder 链路/);
  });

  test("chat prompt builder omits task tracker sections when generation input has no primary", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps());

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: ["terminal_run"],
      activeToolsets: [],
      persona: { name: "Bot", temperament: "", voiceStyle: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      taskTracker: { version: 1, primary: null, parked: [], evidence: [] },
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "闲聊",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.equal(hasPromptSection(system, "task_focus"), false);
    assert.equal(hasPromptSection(system, "active_task_state"), false);
    assert.equal(hasPromptSection(system, "tool_playbooks"), false);
  });

  test("scheduled prompt applies content safety projection to trigger text", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps({
      contentSafetyService: {
        async projectPromptMessages<
          H extends TestPromptHistoryMessage,
          B extends TestPromptBatchMessage
        >(input: {
          recentMessages: H[];
          batchMessages: B[];
        }) {
          return { ...input, events: [] };
        },
        async projectLlmMessages(input: { messages: Array<{ role: string; content: unknown }> }) {
          return {
            messages: input.messages.map((message) => (
              message.role === "user" && typeof message.content === "string" && message.content.includes("scheduled-unsafe")
                ? { ...message, content: "<内容安全\n类型: 内容\n状态: 已屏蔽\n>" }
                : message
            )),
            events: []
          };
        }
      }
    }));

    const result = await builder.buildScheduledPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      visibleToolNames: [],
      activeToolsets: [],
      trigger: {
        kind: "scheduled_instruction",
        jobName: "测试任务",
        taskInstruction: "scheduled-unsafe 原始任务"
      },
      persona: { name: "Bot", temperament: "", voiceStyle: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      targetContext: {
        chatType: "private",
        userId: "10001",
        senderName: "Tester"
      }
    });

    const rendered = result.promptMessages.map((message) => String(message.content ?? "")).join("\n");
    assert.match(rendered, /<内容安全/);
    assert.doesNotMatch(rendered, /scheduled-unsafe 原始任务/);
  });

  test("scheduled instruction prompt does not inherit active task guidance", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps());

    const result = await builder.buildScheduledPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      visibleToolNames: ["terminal_run"],
      activeToolsets: [],
      trigger: {
        kind: "scheduled_instruction",
        jobName: "提醒",
        taskInstruction: "到点提醒用户喝水"
      },
      persona: { name: "Bot", temperament: "", voiceStyle: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      taskTracker: createActiveTaskTracker(),
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      targetContext: {
        chatType: "private",
        userId: "10001",
        senderName: "Tester"
      }
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.equal(hasPromptSection(system, "task_focus"), false);
    assert.equal(hasPromptSection(system, "active_task_state"), false);
    assert.equal(hasPromptSection(system, "tool_playbooks"), false);
  });

  test("background trigger prompt may include active task guidance", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps());

    const result = await builder.buildScheduledPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      visibleToolNames: ["terminal_read"],
      activeToolsets: [],
      trigger: {
        kind: "terminal_session_closed",
        jobName: "后台终端",
        taskInstruction: "查看后台终端结果",
        resourceId: "res_shell_1",
        command: "npm test",
        cwd: "/tmp",
        exitCode: 0,
        signal: null,
        output: "ok",
        outputTruncated: false
      },
      persona: { name: "Bot", temperament: "", voiceStyle: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      taskTracker: createActiveTaskTracker(),
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      targetContext: {
        chatType: "private",
        userId: "10001",
        senderName: "Tester"
      }
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.equal(hasPromptSection(system, "task_focus"), true);
    assert.equal(hasPromptSection(system, "active_task_state"), true);
  });

  test("comfy completed scheduled prompt enriches result file handles from asset store", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps({
      chatFileStore: {
        async getMany(fileIds: string[]) {
          assert.deepEqual(fileIds, ["file_comfy_1"]);
          return [{
            fileId: "file_comfy_1",
            fileRef: "chat_comfy0001.png",
            kind: "image",
            origin: "comfy_generated",
            chatFilePath: "workspace/media/file_comfy_1.png",
            sourceName: "result.png",
            mimeType: "image/png",
            sizeBytes: 123,
            createdAtMs: 456,
            sourceContext: {},
            caption: null
          }];
        }
      } as any
    }));

    const result = await builder.buildScheduledPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      visibleToolNames: ["asset_media_view", "asset_send_to_chat"],
      activeToolsets: [],
      trigger: {
        kind: "comfy_task_completed",
        jobName: "图片任务",
        taskInstruction: "检查结果后决定是否发送",
        taskId: "task_1",
        templateId: "template_a",
        positivePrompt: "red house",
        aspectRatio: "1:1",
        resolvedWidth: 1024,
        resolvedHeight: 1024,
        workspaceFileIds: ["file_comfy_1"],
        chatFilePaths: ["workspace/media/file_comfy_1.png"],
        comfyPromptId: "prompt_1",
        autoIterationIndex: 1,
        maxAutoIterations: 2
      },
      persona: { name: "Bot", temperament: "", voiceStyle: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      targetContext: {
        chatType: "private",
        userId: "10001",
        senderName: "Tester"
      }
    });

    const rendered = result.promptMessages.map((message) => String(message.content ?? "")).join("\n");
    assert.match(rendered, /结果文件 asset_handle/);
    assert.match(rendered, /asset_id=file_comfy_1/);
    assert.match(rendered, /chat_comfy0001\.png/);
    assert.match(rendered, /view_media:asset_media_view/);
    assert.match(rendered, /args=\{"asset_ref":"chat_comfy0001.png"\}/);
    assert.match(rendered, /send_to_chat:asset_send_to_chat/);
    assert.doesNotMatch(rendered, /inspect_media:asset_media_inspect/);
  });

  test("download completed scheduled prompt enriches result asset handle from asset store", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps({
      chatFileStore: {
        async getFile(fileId: string) {
          assert.equal(fileId, "file_download_1");
          return {
            fileId: "file_download_1",
            fileRef: "report_downloaded.pdf",
            kind: "file",
            origin: "browser_download",
            chatFilePath: "workspace/media/file_download_1.pdf",
            sourceName: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1234,
            createdAtMs: 5678,
            sourceContext: {},
            caption: null
          };
        }
      } as any
    }));

    const result = await builder.buildScheduledPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      visibleToolNames: ["asset_send_to_chat"],
      activeToolsets: [],
      trigger: {
        kind: "download_completed",
        jobName: "下载任务",
        taskInstruction: "下载后发给用户",
        resourceId: "res_download_1",
        sourceUrl: "https://example.com/report.pdf",
        fileId: "file_download_1",
        fileRef: "report_downloaded.pdf",
        chatFilePath: "workspace/media/file_download_1.pdf",
        sourceName: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
        fileKind: "file"
      },
      persona: { name: "Bot", temperament: "", voiceStyle: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      targetContext: {
        chatType: "private",
        userId: "10001",
        senderName: "Tester"
      }
    });

    const rendered = result.promptMessages.map((message) => String(message.content ?? "")).join("\n");
    assert.match(rendered, /结果文件 asset_handle/);
    assert.match(rendered, /asset_id=file_download_1/);
    assert.match(rendered, /asset_ref=report_downloaded\.pdf/);
    assert.match(rendered, /send_to_chat:asset_send_to_chat/);
    assert.match(rendered, /args=\{"asset_ref":"report_downloaded.pdf"\}/);
  });

  test("assistant chat prompt injects global persona but still avoids memory rule and scenario stores", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          throw new Error("assistant should not load npc profiles");
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          throw new Error("assistant should not load global rules");
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          throw new Error("assistant should not load toolset rules");
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("assistant should not load scenario state");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      modeId: "assistant",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      persona: {
        name: "Ignored Persona",
        temperament: "",
        voiceStyle: ""
      },
      relationship: "known",
      participantProfiles: [{
        userId: "10002",
        displayName: "Bob",
        relationshipLabel: "熟人"
      }],
      currentUser: {
        userId: "10001",
        relationship: "known",
        memories: [{ id: "mem_1", title: "旧记忆", content: "不应出现", updatedAt: 1 }]
      } as any,
      historySummary: "之前讨论过文件处理。",
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "继续",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.equal(hasPromptSection(system, "global_persona"), true);
    assert.match(system, /全局 persona：名字=Ignored Persona；性格底色=；语气风格=/);
    assert.match(system, /AI assistant 模式工作/);
    assert.doesNotMatch(system, /current_user_memories/);
    assert.doesNotMatch(system, /current_user_profile/);
    assert.doesNotMatch(system, /memory_write_decision/);
  });

  test("chat prompt logs suppressed lower-priority memory items", async () => {
    const loggerEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const builder = createGenerationPromptBuilder({
      logger: {
        info(payload: Record<string, unknown>, event: string) {
          loggerEvents.push({ payload, event });
        }
      } as any,
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          return [{ id: "rule_1", title: "输出顺序", content: "先给结论再展开。", kind: "workflow", source: "owner_explicit", createdAt: 1, updatedAt: 1 }];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      contextStore: {
        listUserPromptFacts() {
          return [{
            id: "mem_1",
            title: "输出顺序",
            content: "先给结论再展开。",
            kind: "fact",
            source: "user_explicit",
            createdAt: 1,
            updatedAt: 1
          }];
        },
        listUserFacts() {
          return [];
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("should not load scenario_host state in rp_assistant prompt");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      persona: {
        name: "Mizune",
        temperament: "",
        voiceStyle: ""
      },
      relationship: "known",
      participantProfiles: [],
      currentUser: {
        userId: "10001",
        relationship: "known",
        memories: [{
          id: "mem_1",
          title: "输出顺序",
          content: "先给结论再展开。",
          kind: "fact",
          source: "user_explicit",
          createdAt: 1,
          updatedAt: 1
        }]
      } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "记住",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }]
    });

    assert.equal(loggerEvents.some((item) => item.event === "prompt_memory_items_suppressed"), true);
    const suppressionEvent = loggerEvents.find((item) => item.event === "prompt_memory_items_suppressed");
    assert.equal((suppressionEvent?.payload.suppressions as Array<{ category: string }>)[0]?.category, "user_memories");
  });

  test("scenario_host profile setup prompt uses scenario profile setup section", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig({
        llm: {
          enabled: true,
          models: { main: { supportsVision: false } }
        }
      }),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          return {
            version: 3 as const,
            profile: {
              theme: "",
              worldBaseline: "",
              narrationStyle: "",
              boundaries: ""
            },
            currentSituation: "场景尚未开始，请根据玩家接下来的行动开始主持。",
            currentLocation: null,
            sceneSummary: "",
            player: { userId: "u1", displayName: "Alice" },
            inventory: [],
            objectives: [],
            loreEntries: [],
            entities: [],
            relations: [],
            journal: [],
            mechanics: { ruleStyle: "freeform" as const, dicePolicy: "", difficultyScale: "", successStates: [] },
            flags: {},
            initialized: false,
            turnIndex: 0
          };
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:u1",
      modeId: "scenario_host",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      lateSystemMessages: [],
      replayMessages: [],
      persona: {
        name: "主持者",
        temperament: "",
        voiceStyle: ""
      },
      relationship: "owner",
      participantProfiles: [],
      currentUser: null,
      historySummary: null,
      historyForPrompt: [],
      debugMarkers: [],
      internalTranscript: [],
      lastLlmUsage: null,
      abortSignal: new AbortController().signal,
      batchMessages: [{
        userId: "u1",
        senderName: "Alice",
        text: "开始游戏",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }],
      draftMode: {
        target: "scenario",
        phase: "setup",
        profile: {
          theme: "",
          narrationStyle: "",
          worldBaseline: "",
          boundaries: ""
        },
        missingFields: ["theme", "narrationStyle", "worldBaseline"]
      }
    });

    const systemContent = result.promptMessages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    assert.ok(systemContent.includes("scenario_profile_setup_mode"), `Expected scenario_profile_setup_mode section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("global_persona_base"), `Expected global_persona_base section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("draft_workflow"), `Expected draft_workflow section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("scenario_profile_snapshot"), `Expected scenario_profile_snapshot section, got: ${systemContent.slice(0, 400)}`);
    assert.match(systemContent, /以下全局 persona 是当前实例在所有模式下共享的底座/);
    assert.match(systemContent, /全局 persona：名字=主持者；性格底色=；语气风格=/);
    assert.match(systemContent, /当前 Scenario 资料只是建立在这层基础上的模式补充/);
    assert.match(systemContent, /你当前只在Scenario 资料的临时草稿上工作/);
    assert.match(systemContent, /待补全：[\s\S]*- 主题：题材、氛围或想要长期主持的类型/);
    assert.ok(!systemContent.includes("host_identity"), `Expected no host_identity section in setup mode, got: ${systemContent.slice(0, 400)}`);
    assert.ok(!systemContent.includes("玩家动作"), `Expected no runtime scenario input protocol in setup mode, got: ${systemContent.slice(0, 400)}`);
    assert.ok(!systemContent.includes("不要在段落结尾反问玩家下一步"), `Expected no runtime pacing rule in setup mode, got: ${systemContent.slice(0, 400)}`);
  });

  test("scenario_host prompt injects global persona, scenario profile, and scenario state", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          throw new Error("scenario_host should not read global rules");
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          throw new Error("scenario_host should not read toolset rules");
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          return {
            version: 3,
            profile: {
              theme: "",
              worldBaseline: "",
              narrationStyle: "",
              boundaries: ""
            },
            currentSituation: "玩家刚抵达废弃钟楼门口。",
            currentLocation: "旧钟楼外",
            sceneSummary: "夜色、迷雾、远处有钟声。",
            player: { userId: "10001", displayName: "Tester" },
            inventory: [{ ownerId: "10001", item: "提灯", quantity: 1 }],
            objectives: [{ id: "obj_1", title: "进入钟楼", status: "active", summary: "找到入口" }],
            loreEntries: [{
              id: "bell-lore",
              title: "钟楼事实",
              content: "钟楼附近会周期性响起钟声",
              tags: [],
              activationKeys: [],
              enabled: true,
              priority: 100,
              createdAtTurn: 0,
              updatedAtTurn: 3
            }],
            entities: [],
            relations: [],
            journal: [],
            mechanics: { ruleStyle: "freeform" as const, dicePolicy: "", difficultyScale: "", successStates: [] },
            flags: { heard_bell: true },
            turnIndex: 3
          };
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      modeId: "scenario_host",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: ["get_scenario_state"],
      activeToolsets: [{
        id: "scenario_host_state",
        title: "场景状态",
        description: "维护场景状态",
        toolNames: ["get_scenario_state"]
      }],
      persona: {
        name: "Bot",
        temperament: "",
        voiceStyle: ""
      },
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known", memories: [{ id: "mem_1", title: "旧记忆", content: "不应出现", updatedAt: 1 }] } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "我推开钟楼的门",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }],
      modeProfile: {
        target: "scenario",
        profile: {
          theme: "钟楼怪谈",
          narrationStyle: "冷静克制",
          worldBaseline: "海边小城潜伏超自然异象",
          boundaries: "从异响和环境异常切入"
        }
      }
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.equal(hasPromptSection(system, "global_persona"), true);
    assert.match(system, /全局 persona：名字=Bot；性格底色=；语气风格=/);
    assert.match(system, /剧情主持模式下的场景主持者/);
    assert.equal(hasPromptSection(system, "scenario_profile"), true);
    assert.match(system, /当前会话 Scenario 资料：主题=钟楼怪谈；世界基线=海边小城潜伏超自然异象；叙事风格=冷静克制/);
    assert.match(system, /模式补充：边界=从异响和环境异常切入/);
    assert.doesNotMatch(system, /标题=/);
    assert.match(system, /当前位置=旧钟楼外/);
    assert.match(system, /`\*` 开头表示玩家动作声明/);
    assert.match(system, /`#` 开头表示场外指令或提问/);
    assert.match(system, /无前缀文本默认视为玩家角色对白/);
    assert.match(system, /先用叙事语气落地玩家刚刚声明的动作或对白已经发生/);
    assert.match(system, /不要代替玩家决定、行动、说话或描写其内心/);
    assert.match(system, /不要在段落结尾反问玩家下一步要做什么/);
    assert.match(system, /不要默认列出可选行动让玩家选择/);
    assert.match(system, /单轮只做小步推进/);
    assert.doesNotMatch(system, /RP 全局资料/);
    assert.doesNotMatch(system, /global_rules/);
  });

  test("rp_assistant prompt injects global persona and rp profile together", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("rp_assistant prompt should not load scenario state");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:u1",
      modeId: "rp_assistant",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      persona: {
        name: "小满",
        temperament: "冷静细致",
        voiceStyle: "短句克制"
      },
      relationship: "owner",
      participantProfiles: [],
      currentUser: { userId: "u1", relationship: "owner" } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "u1",
        senderName: "Alice",
        text: "今晚回家吗",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }],
      modeProfile: {
        target: "rp",
        profile: {
          identity: "图书管理员",
          background: "黑色风衣，短发",
          continuityFacts: "",
          boundaries: "绝不跳出角色"
        }
      }
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.equal(hasPromptSection(system, "global_persona"), true);
    assert.match(system, /全局 persona：名字=小满；性格底色=冷静细致；语气风格=短句克制/);
    assert.equal(hasPromptSection(system, "rp_profile"), true);
    assert.match(system, /RP 全局资料：身份定位=图书管理员；稳定背景=黑色风衣，短发；边界=绝不跳出角色/);
    assert.match(system, /RP assistant 模式/);
    assert.doesNotMatch(system, /scenario_state/);
  });

  test("scenario_host profile config prompt uses config-specific profile guidance", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          throw new Error("scenario config prompt should not load global rules");
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          throw new Error("scenario config prompt should not load toolset rules");
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("scenario config prompt should not load runtime scenario state");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:u1",
      modeId: "scenario_host",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      lateSystemMessages: [],
      replayMessages: [],
      persona: {
        name: "主持者",
        temperament: "",
        voiceStyle: ""
      },
      relationship: "owner",
      participantProfiles: [],
      currentUser: null,
      historySummary: null,
      historyForPrompt: [],
      debugMarkers: [],
      internalTranscript: [],
      lastLlmUsage: null,
      abortSignal: new AbortController().signal,
      batchMessages: [{
        userId: "u1",
        senderName: "Alice",
        text: "把叙事风格改紧凑一点",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }],
      draftMode: {
        target: "scenario",
        phase: "config",
        profile: {
          theme: "都市怪谈",
          narrationStyle: "紧凑克制",
          worldBaseline: "现代都市里潜伏超自然现象",
          boundaries: ""
        },
        missingFields: ["boundaries"]
      }
    });

    const systemContent = result.promptMessages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    assert.ok(systemContent.includes("scenario_profile_config_mode"), `Expected scenario_profile_config_mode section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("global_persona_base"), `Expected global_persona_base section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("draft_workflow"), `Expected draft_workflow section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("scenario_profile_snapshot"), `Expected scenario_profile_snapshot section, got: ${systemContent.slice(0, 400)}`);
    assert.match(systemContent, /当前 Scenario 资料只是建立在这层基础上的模式补充/);
    assert.match(systemContent, /不要把已属于 persona 的内容重复搬进 Scenario 资料/);
    assert.match(systemContent, /当前处于当前会话 Scenario 资料配置阶段/);
    assert.match(systemContent, /当前草稿已明确：主题、世界基线、叙事风格/);
    assert.match(systemContent, /可在需要时继续补充：边界/);
    assert.match(systemContent, /已设定：主题=都市怪谈；世界基线=现代都市里潜伏超自然现象；叙事风格=紧凑克制/);
    assert.match(systemContent, /优先按 owner 本轮明确要求做局部调整/);
    assert.match(systemContent, /若本轮只是微调单个字段，就直接改那一项/);
    assert.match(systemContent, /\.cancel/);
    assert.ok(!systemContent.includes("host_identity"), `Expected no runtime host identity section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(!systemContent.includes("scenario_state"), `Expected no runtime scenario state section, got: ${systemContent.slice(0, 400)}`);
  });

  test("rp draft prompt includes global persona as the shared base", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("rp draft prompt should not load scenario state");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:u1",
      modeId: "rp_assistant",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      lateSystemMessages: [],
      replayMessages: [],
      persona: {
        name: "小满",
        temperament: "冷静细致",
        voiceStyle: "短句克制"
      },
      relationship: "owner",
      participantProfiles: [],
      currentUser: null,
      historySummary: null,
      historyForPrompt: [],
      debugMarkers: [],
      internalTranscript: [],
      lastLlmUsage: null,
      abortSignal: new AbortController().signal,
      batchMessages: [{
        userId: "u1",
        senderName: "Alice",
        text: "把 RP 前提改成雨夜同居",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: Date.now()
      }],
      draftMode: {
        target: "rp",
        phase: "config",
        profile: {
          identity: "图书管理员",
          background: "",
          continuityFacts: "",
          boundaries: "绝不跳出角色"
        },
        missingFields: ["background", "continuityFacts"]
      }
    });

    const systemContent = result.promptMessages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    assert.ok(systemContent.includes("rp_profile_config_mode"), `Expected rp_profile_config_mode section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("global_persona_base"), `Expected global_persona_base section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("draft_workflow"), `Expected draft_workflow section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(systemContent.includes("rp_profile_snapshot"), `Expected rp_profile_snapshot section, got: ${systemContent.slice(0, 400)}`);
    assert.match(systemContent, /全局 persona：名字=小满；性格底色=冷静细致；语气风格=短句克制/);
    assert.match(systemContent, /当前 RP 资料只是建立在这层基础上的模式补充/);
    assert.match(systemContent, /不要把已属于 persona 的内容重复搬进 RP 资料/);
    assert.match(systemContent, /当前草稿已明确：身份定位、边界/);
    assert.match(systemContent, /核心字段仍缺：稳定背景/);
    assert.match(systemContent, /可在需要时继续补充：连续性事实/);
    assert.match(systemContent, /已设定：身份定位=图书管理员；边界=绝不跳出角色/);
  });

  test("chat prompt retrieves context without depositing current turn into memory store", async () => {
    const rawMessages: Array<{ messageId: string; text: string; userId: string }> = [];
    const upsertedChunks: Array<{ itemId: string; text: string }> = [];
    const upsertedFacts: Array<{ title: string; content: string }> = [];
    const retrievalCalls: Array<{ queryText: string; excludeItemIds: string[] }> = [];
    const promptReports: Array<{
      sessionId: string;
      queryText: string;
      currentUserMemories: unknown[];
      availableUserFactCount: number;
      userFactLimit: number;
      currentSessionContext: unknown[];
      availableSessionFactCount: number;
      sessionFactLimit: number;
      retrievedUserContext: unknown[];
      semanticRetrievalAttempted: boolean;
    }> = [];
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig({
        context: {
          retrieval: {
            maxFixedUserFacts: 1
          }
        }
      }),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      contextStore: {
        listUserFacts() {
          return [{
            id: "mem_pref_2",
            title: "长尾偏好",
            content: "这条长尾用户记忆不应该固定进入 prompt",
            kind: "preference",
            source: "user_explicit",
            createdAt: 1,
            updatedAt: 999,
            importance: 1
          }, {
            id: "mem_pref_1",
            title: "检索偏好",
            content: "用户喜欢 Orama 版上下文检索",
            kind: "preference",
            source: "user_explicit",
            createdAt: 1,
            updatedAt: 1,
            importance: 4
          }];
        },
        listUserPromptFacts() {
          return [{
            id: "mem_pref_1",
            title: "检索偏好",
            content: "用户喜欢 Orama 版上下文检索",
            kind: "preference",
            source: "user_explicit",
            createdAt: 1,
            updatedAt: 1,
            importance: 4
          }];
        },
        upsertUserFact(input: { title: string; content: string }) {
          upsertedFacts.push({ title: input.title, content: input.content });
          return {};
        },
        upsertRawMessages(input: Array<{ messageId: string; text: string; userId: string }>) {
          rawMessages.push(...input);
        },
        upsertUserSearchChunk(input: { itemId: string; text: string }) {
          upsertedChunks.push({ itemId: input.itemId, text: input.text });
        },
        sweepUserSearchChunks() {
          return { deletedCount: 0 };
        }
      } as any,
      contextRetrievalService: {
        async retrieveUserContext(input: { queryText: string; excludeItemIds?: Iterable<string> }) {
          retrievalCalls.push({
            queryText: input.queryText,
            excludeItemIds: Array.from(input.excludeItemIds ?? [])
          });
          return [{
            itemId: "ctx_old_1",
            scope: "user",
            layer: "episode",
            subjectKind: "user",
            subjectId: "10001",
            sourceType: "chunk",
            userId: "10001",
            title: "旧上下文",
            text: "用户之前在处理 SQLite 迁移",
            score: 0.91,
            updatedAt: 1
          }];
        },
        recordPromptMemoryReport(input: {
          sessionId: string;
          queryText: string;
          currentUserMemories: unknown[];
          availableUserFactCount: number;
          userFactLimit: number;
          currentSessionContext: unknown[];
          availableSessionFactCount: number;
          sessionFactLimit: number;
          retrievedUserContext: unknown[];
          semanticRetrievalAttempted: boolean;
        }) {
          promptReports.push(input);
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("should not load scenario_host state");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      persona: { prompt: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: {
        userId: "10001",
        relationship: "known",
        memories: []
      } as any,
      historySummary: null,
      historyForPrompt: [{
        role: "assistant",
        content: "我们刚看过 SQLite schema。",
        timestampMs: 100
      }, {
        role: "assistant",
        content: "收到。",
        timestampMs: 150
      }],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "记住我喜欢 Orama 版上下文检索",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: 200
      }]
    });

    assert.equal(rawMessages.length, 0);
    assert.equal(upsertedFacts.length, 0);
    assert.equal(upsertedChunks.length, 0);
    assert.equal(retrievalCalls.length, 1);
    assert.equal(retrievalCalls[0]?.queryText, "Tester：记住我喜欢 Orama 版上下文检索");
    assert.deepEqual(retrievalCalls[0]?.excludeItemIds, ["mem_pref_1"]);
    assert.equal(promptReports.length, 1);
    assert.equal(promptReports[0]?.sessionId, "qqbot:p:10001");
    assert.equal(promptReports[0]?.queryText, "Tester：记住我喜欢 Orama 版上下文检索");
    assert.equal(promptReports[0]?.currentUserMemories.length, 1);
    assert.equal(promptReports[0]?.availableUserFactCount, 1);
    assert.equal(promptReports[0]?.userFactLimit, 1);
    assert.equal(promptReports[0]?.currentSessionContext.length, 0);
    assert.equal(promptReports[0]?.availableSessionFactCount, 0);
    assert.equal(promptReports[0]?.retrievedUserContext.length, 1);
    assert.equal(promptReports[0]?.semanticRetrievalAttempted, true);
    assert.match(readPromptSystemText(result.promptMessages), /retrieved_user_context/);
    assert.match(readPromptSystemText(result.promptMessages), /用户之前在处理 SQLite 迁移/);
    assert.match(readPromptSystemText(result.promptMessages), /用户喜欢 Orama 版上下文检索/);
    assert.doesNotMatch(readPromptSystemText(result.promptMessages), /长尾用户记忆不应该固定进入 prompt/);
  });

  test("chat prompt does not depend on context deposition methods", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig(),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: {
        async transcribeMany() {
          return [];
        }
      } as any,
      npcDirectory: {
        listProfiles() {
          return [];
        }
      } as any,
      browserService: {
        async listPages() {
          return { pages: [] };
        }
      } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      downloadRuntime: { list() { return []; } } as any,
      mediaVisionService: {
        async prepareFilesForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      toolsetRuleStore: {
        async getAll() {
          return [];
        }
      } as any,
      contextStore: {
        listUserPromptFacts() {
          return [];
        },
        listUserFacts() {
          return [];
        },
        upsertUserSearchChunk() {
          throw new Error("context store unavailable");
        },
        sweepUserSearchChunks() {
          throw new Error("context store unavailable");
        }
      } as any,
      contextRetrievalService: {
        async retrieveUserContext() {
          return [];
        }
      } as any,
      scenarioHostStateStore: {
        async ensure() {
          throw new Error("should not load scenario_host state");
        }
      } as any,
      shellRuntime: {
        async listSessionResources() {
          return [];
        }
      } as any,
      setupStore: {
        describeMissingFields() {
          return [];
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      persona: { prompt: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: {
        userId: "10001",
        relationship: "known"
      } as any,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "这条消息仍应正常构建 prompt",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: 200
      }]
    });

    assert.match(JSON.stringify(result.promptMessages.at(-1)?.content ?? ""), /这条消息仍应正常构建 prompt/);
  });

  test("chat prompt exposes session-scoped context from store without requiring semantic retrieval", async () => {
    const builder = createGenerationPromptBuilder(createMinimalPromptBuilderDeps({
      contextStore: {
        listUserPromptFacts() {
          return [];
        },
        listUserFacts() {
          return [];
        },
        listSessionFacts(sessionId: string) {
          assert.equal(sessionId, "qqbot:p:10001");
          return [{
            id: "session_mem_1",
            title: "会话用途",
            content: "此会话专门用于记忆系统测试",
            kind: "fact",
            source: "inferred",
            createdAt: 1,
            updatedAt: 1,
            importance: 4
          }];
        }
      } as any,
      contextRetrievalService: {
        async retrieveUserContext() {
          throw new Error("semantic retrieval should not be required for session context");
        }
      } as any
    }));

    const result = await builder.buildChatPromptMessages({
      sessionId: "qqbot:p:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      persona: { prompt: "" } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: null,
      historySummary: null,
      historyForPrompt: [],
      internalTranscript: [],
      lastLlmUsage: null,
      batchMessages: [{
        userId: "10001",
        senderName: "Tester",
        text: "继续",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: 200
      }]
    });

    const system = readPromptSystemText(result.promptMessages);
    assert.match(system, /current_session_context/);
    assert.match(system, /会话用途：此会话专门用于记忆系统测试/);
  });

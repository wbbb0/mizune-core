import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationPromptBuilder } from "../../src/app/generation/generationPromptBuilder.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

  test("setup prompt prepares image visuals when vision is enabled", async () => {
    const capturedImageIdCalls: string[][] = [];
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig({
        llm: {
          enabled: true,
          mainRouting: {
            smallModelRef: ["main"],
            largeModelRef: ["main"]
          },
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
      historyForPrompt: [],
      recentToolEvents: [],
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
      visibleToolNames: ["list_live_resources", "shell_run", "open_page"],
      activeToolsets: [
        {
          id: "shell_runtime",
          title: "Shell 运行时",
          description: "执行与交互 shell 会话，并复用 live_resource。",
          toolNames: ["list_live_resources", "shell_run"],
          promptGuidance: ["需要运行命令时优先复用现有 shell 资源。"]
        },
        {
          id: "web_research",
          title: "网页检索与浏览",
          description: "搜索网页、打开页面、交互与截图。",
          toolNames: ["open_page"],
          promptGuidance: ["需要网页状态时再进入网页检索与浏览。"]
        }
      ],
      persona: {
        name: "Bot",
        identity: "助手",
        personality: "冷静",
        speakingStyle: "简洁",
        virtualAppearance: "",
        hobbies: "",
        likesAndDislikes: "",
        familyBackground: "",
        secrets: "",
        residence: "",
        roleplayRequirements: ""
      } as any,
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known" } as any,
      historySummary: null,
      historyForPrompt: [],
      recentToolEvents: [],
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

    const system = String(result.promptMessages[0]?.content ?? "");
    assert.match(system, /当前可复用 live_resource/);
    assert.match(system, /res_browser_7 \| browser \| active \| Docs 7 \| 浏览第 7 个页面/);
    assert.match(system, /res_browser_1 \| browser \| active \| Docs 1/);
    assert.match(system, /res_shell_1 \| shell \| active \| npm test @ \/repo \| 跑测试/);
  });

  test("assistant chat prompt does not load persona memory rule or scenario stores", async () => {
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
        coreIdentity: "助手",
        personality: "",
        interests: "",
        background: "",
        speechStyle: ""
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
      recentToolEvents: [],
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

    const system = String(result.promptMessages[0]?.content ?? "");
    assert.match(system, /普通中文 assistant/);
    assert.doesNotMatch(system, /current_user_memories/);
    assert.doesNotMatch(system, /current_user_profile/);
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
        coreIdentity: "搭档",
        personality: "",
        interests: "",
        background: "",
        speechStyle: ""
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
      recentToolEvents: [],
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

  test("scenario_host setup prompt uses host_setup_mode section when isInSetup=true", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig({
        llm: {
          enabled: true,
          mainRouting: {
            smallModelRef: ["main"],
            largeModelRef: ["main"]
          },
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
            version: 1 as const,
            currentSituation: "场景尚未开始，请根据玩家接下来的行动开始主持。",
            currentLocation: null,
            sceneSummary: "",
            player: { userId: "u1", displayName: "Alice" },
            inventory: [],
            objectives: [],
            worldFacts: [],
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
        coreIdentity: "",
        personality: "",
        speechStyle: "",
        interests: "",
        background: ""
      },
      relationship: "owner",
      participantProfiles: [],
      currentUser: null,
      historySummary: null,
      historyForPrompt: [],
      recentToolEvents: [],
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
      isInSetup: true
    });

    const systemContent = result.promptMessages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    assert.ok(systemContent.includes("host_setup_mode"), `Expected host_setup_mode section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(!systemContent.includes("host_identity"), `Expected no host_identity section in setup mode, got: ${systemContent.slice(0, 400)}`);
    assert.ok(!systemContent.includes("玩家动作"), `Expected no runtime scenario input protocol in setup mode, got: ${systemContent.slice(0, 400)}`);
    assert.ok(!systemContent.includes("不要在段落结尾反问玩家下一步"), `Expected no runtime pacing rule in setup mode, got: ${systemContent.slice(0, 400)}`);
  });

  test("scenario_host prompt injects scenario state and avoids rp identity lines", async () => {
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
            version: 1,
            currentSituation: "玩家刚抵达废弃钟楼门口。",
            currentLocation: "旧钟楼外",
            sceneSummary: "夜色、迷雾、远处有钟声。",
            player: { userId: "10001", displayName: "Tester" },
            inventory: [{ ownerId: "10001", item: "提灯", quantity: 1 }],
            objectives: [{ id: "obj_1", title: "进入钟楼", status: "active", summary: "找到入口" }],
            worldFacts: ["钟楼附近会周期性响起钟声"],
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
        coreIdentity: "助手",
        personality: "",
        interests: "",
        background: "",
        speechStyle: ""
      },
      relationship: "known",
      participantProfiles: [],
      currentUser: { userId: "10001", relationship: "known", memories: [{ id: "mem_1", title: "旧记忆", content: "不应出现", updatedAt: 1 }] } as any,
      historySummary: null,
      historyForPrompt: [],
      recentToolEvents: [],
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
      }]
    });

    const system = String(result.promptMessages[0]?.content ?? "");
    assert.match(system, /剧情主持模式下的场景主持者/);
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
    assert.doesNotMatch(system, /你是具有角色扮演属性的聊天角色/);
    assert.doesNotMatch(system, /global_rules/);
  });

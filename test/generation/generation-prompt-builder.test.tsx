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
      contextStore: {
        listUserFacts() {
          return [{
            id: "mem_1",
            title: "输出顺序",
            content: "先给结论再展开。",
            kind: "fact",
            source: "user_explicit",
            createdAt: 1,
            updatedAt: 1
          }];
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
          toolNames: ["terminal_list", "terminal_run"],
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
        temperament: "冷静",
        speakingStyle: "简洁",
        globalTraits: "助手",
        generalPreferences: ""
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

    const system = String(result.promptMessages[0]?.content ?? "");
    assert.match(system, /当前可复用 live_resource/);
    assert.match(system, /res_browser_7 \| browser \| active \| Docs 7 \| 浏览第 7 个页面/);
    assert.match(system, /res_browser_1 \| browser \| active \| Docs 1/);
    assert.match(system, /res_shell_1 \| shell \| active \| npm test @ \/repo \| 跑测试/);
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
        speakingStyle: "",
        globalTraits: "助手",
        generalPreferences: ""
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

    const system = String(result.promptMessages[0]?.content ?? "");
    assert.match(system, /⟦section name="global_persona"⟧/);
    assert.match(system, /全局 persona：名字=Ignored Persona；性格底色=；说话方式=/);
    assert.match(system, /全局补充设定：全局特征=助手/);
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
        listUserFacts() {
          return [{
            id: "mem_1",
            title: "输出顺序",
            content: "先给结论再展开。",
            kind: "fact",
            source: "user_explicit",
            createdAt: 1,
            updatedAt: 1
          }];
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
        speakingStyle: "",
        globalTraits: "搭档",
        generalPreferences: ""
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
        temperament: "",
        speakingStyle: "",
        globalTraits: "",
        generalPreferences: ""
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
          hostStyle: "",
          worldBaseline: "",
          safetyOrTabooRules: "",
          openingPattern: ""
        },
        missingFields: ["theme", "hostStyle", "worldBaseline"]
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
    assert.match(systemContent, /全局 persona：名字=主持者；性格底色=；说话方式=/);
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
        temperament: "",
        speakingStyle: "",
        globalTraits: "助手",
        generalPreferences: ""
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
          hostStyle: "冷静克制",
          worldBaseline: "海边小城潜伏超自然异象",
          safetyOrTabooRules: "避免过度血腥",
          openingPattern: "从异响和环境异常切入"
        }
      }
    });

    const system = String(result.promptMessages[0]?.content ?? "");
    assert.match(system, /⟦section name="global_persona"⟧/);
    assert.match(system, /全局 persona：名字=Bot；性格底色=；说话方式=/);
    assert.match(system, /全局补充设定：全局特征=助手/);
    assert.match(system, /剧情主持模式下的场景主持者/);
    assert.match(system, /⟦section name="scenario_profile"⟧/);
    assert.match(system, /Scenario 全局资料：主题=钟楼怪谈；主持风格=冷静克制；世界基线=海边小城潜伏超自然异象/);
    assert.match(system, /模式补充：安全\/禁忌规则=避免过度血腥；开场模式=从异响和环境异常切入/);
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
        speakingStyle: "短句克制",
        globalTraits: "图书管理员",
        generalPreferences: "旧书、黑咖啡"
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
          selfPositioning: "冷静克制，不轻易示弱",
          socialRole: "图书管理员",
          lifeContext: "雨夜同居",
          physicalPresence: "黑色风衣，短发",
          bondToUser: "恋人",
          closenessPattern: "靠近时会压低声音",
          interactionPattern: "动作克制",
          realityContract: "始终按真人自处",
          continuityFacts: "",
          hardLimits: "绝不跳出角色"
        }
      }
    });

    const system = String(result.promptMessages[0]?.content ?? "");
    assert.match(system, /⟦section name="global_persona"⟧/);
    assert.match(system, /全局 persona：名字=小满；性格底色=冷静细致；说话方式=短句克制/);
    assert.match(system, /全局补充设定：全局特征=图书管理员；通用偏好=旧书、黑咖啡/);
    assert.match(system, /⟦section name="rp_profile"⟧/);
    assert.match(system, /RP 全局资料：自我定位=冷静克制，不轻易示弱；社会角色=图书管理员；生活状态=雨夜同居；外在存在感=黑色风衣，短发；与用户关系=恋人；亲密模式=靠近时会压低声音；互动模式=动作克制；现实契约=始终按真人自处；硬边界=绝不跳出角色/);
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
        speakingStyle: "",
        globalTraits: "",
        generalPreferences: ""
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
        text: "把主持风格改紧凑一点",
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
          hostStyle: "紧凑克制",
          worldBaseline: "现代都市里潜伏超自然现象",
          safetyOrTabooRules: "",
          openingPattern: ""
        },
        missingFields: ["safetyOrTabooRules", "openingPattern"]
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
    assert.match(systemContent, /当前处于 Scenario 全局资料配置阶段/);
    assert.match(systemContent, /当前草稿已明确：主题、主持风格、世界基线/);
    assert.match(systemContent, /可在需要时继续补充：安全\/禁忌规则、开场模式/);
    assert.match(systemContent, /已设定：主题=都市怪谈；主持风格=紧凑克制；世界基线=现代都市里潜伏超自然现象/);
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
        speakingStyle: "短句克制",
        globalTraits: "图书管理员",
        generalPreferences: "旧书、黑咖啡"
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
          selfPositioning: "冷静克制，不轻易示弱",
          socialRole: "图书管理员",
          lifeContext: "雨夜同居",
          physicalPresence: "",
          bondToUser: "",
          closenessPattern: "",
          interactionPattern: "",
          realityContract: "始终按真人自处",
          continuityFacts: "",
          hardLimits: "绝不跳出角色"
        },
        missingFields: ["physicalPresence", "bondToUser", "closenessPattern", "interactionPattern", "continuityFacts"]
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
    assert.match(systemContent, /全局 persona：名字=小满；性格底色=冷静细致；说话方式=短句克制/);
    assert.match(systemContent, /全局补充设定：全局特征=图书管理员；通用偏好=旧书、黑咖啡/);
    assert.match(systemContent, /当前 RP 资料只是建立在这层基础上的模式补充/);
    assert.match(systemContent, /不要把已属于 persona 的内容重复搬进 RP 资料/);
    assert.match(systemContent, /当前草稿已明确：自我定位、社会角色、生活状态、现实契约、硬边界/);
    assert.match(systemContent, /核心字段仍缺：外在存在感、与用户关系、亲密模式、互动模式/);
    assert.match(systemContent, /可在需要时继续补充：连续性事实/);
    assert.match(systemContent, /已设定：自我定位=冷静克制，不轻易示弱；社会角色=图书管理员；生活状态=雨夜同居；现实契约=始终按真人自处；硬边界=绝不跳出角色/);
  });

  test("chat prompt persists searchable context chunks and excludes current batch from retrieval", async () => {
    const rawMessages: Array<{ messageId: string; text: string; userId: string }> = [];
    const upsertedChunks: Array<{ itemId: string; text: string }> = [];
    const upsertedFacts: Array<{ title: string; content: string }> = [];
    const retrievalCalls: Array<{ queryText: string; excludeItemIds: string[] }> = [];
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
          return [];
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
            sourceType: "chunk",
            userId: "10001",
            title: "旧上下文",
            text: "用户之前在处理 SQLite 迁移",
            score: 0.91,
            updatedAt: 1
          }];
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

    assert.equal(rawMessages.length, 1);
    assert.ok(rawMessages[0]?.messageId.startsWith("raw_"));
    assert.equal(rawMessages[0]?.userId, "10001");
    assert.equal(rawMessages[0]?.text, "记住我喜欢 Orama 版上下文检索");
    assert.deepEqual(upsertedFacts, [{
      title: "我喜欢 Orama 版上下文检索",
      content: "我喜欢 Orama 版上下文检索"
    }]);
    assert.equal(upsertedChunks.length, 2);
    assert.ok(upsertedChunks.some((item) => item.itemId.startsWith("ctx_history_") && item.text.includes("SQLite schema")));
    const batchChunk = upsertedChunks.find((item) => item.itemId.startsWith("ctx_batch_"));
    assert.ok(batchChunk);
    assert.equal(retrievalCalls.length, 1);
    assert.equal(retrievalCalls[0]?.queryText, "Tester：记住我喜欢 Orama 版上下文检索");
    assert.deepEqual(retrievalCalls[0]?.excludeItemIds, [batchChunk.itemId]);
    assert.match(String(result.promptMessages[0]?.content ?? ""), /retrieved_user_context/);
    assert.match(String(result.promptMessages[0]?.content ?? ""), /用户之前在处理 SQLite 迁移/);
  });

  test("chat prompt fails open when context chunk deposition fails", async () => {
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

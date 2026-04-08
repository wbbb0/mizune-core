import assert from "node:assert/strict";
import { createGenerationPromptBuilder } from "../src/app/generation/generationPromptBuilder.ts";
import { createTestAppConfig } from "./helpers/config-fixtures.tsx";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("setup prompt prepares image visuals when vision is enabled", async () => {
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
      workspaceService: {} as any,
      mediaWorkspace: {} as any,
      mediaVisionService: {
        async prepareAssetsForModel(imageIds: string[]) {
          capturedImageIdCalls.push(imageIds);
          return [{
            assetId: imageIds[0] ?? "asset_1",
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
      globalMemoryStore: {
        async getAll() {
          return [];
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
      sessionId: "private:10001",
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
          assetId: "asset_1",
          kind: "image",
          source: "chat_message",
          filename: "a.png",
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

    assert.deepEqual(capturedImageIdCalls, [["asset_1"], []]);
    const content = result.promptMessages[1]?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.some((part) => part.type === "image_url"), true);
  });

  await runCase("chat prompt includes stable runtime resource summaries from browser and shell", async () => {
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
      workspaceService: {} as any,
      mediaWorkspace: {} as any,
      mediaVisionService: {
        async prepareAssetsForModel() {
          return [];
        }
      } as any,
      mediaCaptionService: {
        async ensureReady() {
          return new Map();
        }
      } as any,
      globalMemoryStore: {
        async getAll() {
          return [];
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
      sessionId: "private:10001",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: ["list_live_resources", "list_browser_pages", "list_shell_sessions", "shell_run", "open_page"],
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

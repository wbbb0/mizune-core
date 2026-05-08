import test from "node:test";
import assert from "node:assert/strict";
import { TextInspectionService, getTextInspectorModelRefs } from "../../src/services/workspace/textInspectionService.ts";
import { createEmptyUsage } from "../../src/llm/provider/providerTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

function createTextInspectorConfig(options: { dedicated?: boolean } = {}) {
  return createTestAppConfig({
    llm: {
      enabled: true,
      models: {
        textInspector: {
          provider: "test",
          model: "fake-text-inspector",
          modelType: "chat",
          supportsThinking: false,
          thinkingControllable: true,
          supportsVision: false,
          supportsAudioInput: false,
          supportsSearch: false,
          supportsTools: false,
          preserveThinking: false
        }
      },
      routingPresets: {
        test: {
          mainSmall: ["main"],
          mainLarge: ["main"],
          summarizer: ["main"],
          textInspector: options.dedicated ? ["textInspector"] : [],
          sessionCaptioner: ["sessionCaptioner"],
          imageCaptioner: ["main"],
          imageInspector: ["main"],
          audioTranscription: ["transcription"],
          turnPlanner: ["main"],
          embedding: ["embedding"]
        }
      },
      textInspector: {
        enabled: true,
        timeoutMs: 1234,
        enableThinking: false,
        maxConcurrency: 2
      }
    }
  });
}

test("text inspector prefers dedicated route and falls back to summarizer", () => {
  assert.deepEqual(getTextInspectorModelRefs(createTextInspectorConfig({ dedicated: true })), ["textInspector"]);
  assert.deepEqual(getTextInspectorModelRefs(createTextInspectorConfig({ dedicated: false })), ["main"]);
});

test("text inspector sends compact structured prompt and parses result", async () => {
  const calls: any[] = [];
  const service = new TextInspectionService(
    createTextInspectorConfig({ dedicated: true }),
    {
      isConfigured() {
        return true;
      },
      async generate(params: any) {
        calls.push(params);
        return {
          text: JSON.stringify({
            status: "answered",
            found: true,
            answer: "文档提到 Alpha。",
            evidence: ["Alpha detail"],
            confidenceNotes: ["来自片段"]
          }),
          reasoningContent: "",
          usage: createEmptyUsage("textInspector", "fake-text-inspector"),
          providerCallUsages: []
        };
      }
    },
    createSilentLogger()
  );

  const result = await service.inspectPreparedText({
    question: "Alpha 是什么？",
    assetRef: "notes.md",
    chunks: [{
      chunkId: "chunk_1",
      startLine: 1,
      endLine: 2,
      text: "Alpha detail\nBeta detail"
    }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.status, "answered");
  assert.equal(result.results[0]?.answer, "文档提到 Alpha。");
  assert.equal(result.results[0]?.evidence[0], "Alpha detail");
  assert.deepEqual(calls[0].modelRefOverride, ["textInspector"]);
  assert.equal(calls[0].timeoutMsOverride, 1234);
  assert.match(String(calls[0].messages[1].content), /asset_ref: notes\.md/);
});

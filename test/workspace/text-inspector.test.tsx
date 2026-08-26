import test from "node:test";
import assert from "node:assert/strict";
import { TextInspectionService, getTextInspectorModelRefs } from "../../src/services/workspace/textInspectionService.ts";
import { DocumentSummaryService } from "../../src/services/workspace/documentSummaryService.ts";
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

test("document summary service caps model output lengths", async () => {
  const longText = "甲".repeat(2000);
  const calls: any[] = [];
  const service = new DocumentSummaryService(
    createTestAppConfig({
      llm: {
        enabled: true,
        summarizer: {
          enabled: true,
          timeoutMs: 1000,
          enableThinking: false
        },
        routingPresets: {
          test: {
            mainSmall: ["main"],
            mainLarge: ["main"],
            summarizer: ["main"],
            textInspector: [],
            sessionCaptioner: ["sessionCaptioner"],
            imageCaptioner: ["main"],
            imageInspector: ["main"],
            audioTranscription: ["transcription"],
            turnPlanner: ["main"],
            embedding: ["embedding"]
          }
        }
      }
    }),
    {
      isConfigured() {
        return true;
      },
      async generate(input: any) {
        calls.push(input);
        return {
          text: JSON.stringify({
            brief: longText,
            outline: Array.from({ length: 20 }, () => longText),
            key_facts: Array.from({ length: 20 }, () => longText),
            limitations: Array.from({ length: 20 }, () => longText)
          }),
          reasoningContent: "",
          finishReason: { kind: "completed" },
          usage: createEmptyUsage("main", "fake-summarizer"),
          providerCallUsages: []
        };
      }
    },
    createSilentLogger()
  );

  const result = await service.summarizePreparedDocument({
    assetRef: "long.md",
    parser: "plain_text_v1",
    characterCount: longText.length,
    lineCount: 1,
    headings: [],
    chunks: [{ chunkId: "chunk_1", startLine: 1, endLine: 1, text: longText }],
    summaryScope: {
      mode: "head_sample",
      fullDocument: false,
      sampledChunks: 1,
      totalChunks: 3,
      sampledStartLine: 1,
      sampledEndLine: 1,
      sampledCharacters: longText.length
    },
    excerpt: longText
  });

  assert.equal(result.ok, true);
  assert.match(String(calls[0]?.messages?.[0]?.content ?? ""), /只看到了?文档抽样片段|你看到的可能只是文档抽样片段/);
  assert.match(String(calls[0]?.messages?.[0]?.content ?? ""), /limitations 只写本次摘要覆盖限制/);
  assert.match(String(calls[0]?.messages?.[1]?.content ?? ""), /"fullDocument":false/);
  assert.match(String(calls[0]?.messages?.[1]?.content ?? ""), /"totalChunks":3/);
  assert.ok(result.summary.brief.length <= 703);
  assert.equal(result.summary.outline.length, 12);
  assert.ok(result.summary.outline.every((item) => item.length <= 183));
  assert.equal(result.summary.key_facts.length, 12);
  assert.ok(result.summary.key_facts.every((item) => item.length <= 243));
  assert.equal(result.summary.limitations.length, 8);
  assert.ok(result.summary.limitations.every((item) => item.length <= 203));
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
          finishReason: { kind: "completed" },
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

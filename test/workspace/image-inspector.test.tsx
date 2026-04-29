import test from "node:test";
import assert from "node:assert/strict";
import { MediaInspectionService } from "../../src/services/workspace/mediaInspectionService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

function createInspectorConfig() {
  return createTestAppConfig({
    llm: {
      enabled: true,
      providers: {
        vision: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "test-key",
          proxy: false
        }
      },
      models: {
        primary: {
          provider: "vision",
          model: "primary-vision",
          supportsThinking: false,
          supportsVision: true,
          supportsAudioInput: false,
          supportsSearch: false,
          supportsTools: false,
          preserveThinking: false
        },
        secondary: {
          provider: "vision",
          model: "secondary-vision",
          supportsThinking: false,
          supportsVision: true,
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
          sessionCaptioner: ["sessionCaptioner"],
          imageCaptioner: ["primary"],
          imageInspector: ["primary", "secondary"],
          audioTranscription: ["transcription"],
          turnPlanner: ["main"]
        }
      },
      imageInspector: {
        enabled: true,
        timeoutMs: 1234,
        enableThinking: false,
        maxConcurrency: 2
      }
    }
  });
}

function createMixedVisionInspectorConfig() {
  return createTestAppConfig({
    llm: {
      enabled: true,
      providers: {
        vision: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "test-key",
          proxy: false
        }
      },
      models: {
        textOnly: {
          provider: "vision",
          model: "text-only-model",
          supportsThinking: false,
          supportsVision: false,
          supportsAudioInput: false,
          supportsSearch: false,
          supportsTools: false,
          preserveThinking: false
        },
        visual: {
          provider: "vision",
          model: "visual-model",
          supportsThinking: false,
          supportsVision: true,
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
          sessionCaptioner: ["sessionCaptioner"],
          imageCaptioner: ["visual"],
          imageInspector: ["textOnly", "visual"],
          audioTranscription: ["transcription"],
          turnPlanner: ["main"]
        }
      },
      imageInspector: {
        enabled: true,
        timeoutMs: 1234,
        enableThinking: false,
        maxConcurrency: 2
      }
    }
  });
}

function createRecordingLogger() {
  const warnings: Array<{ payload: unknown; message: string }> = [];
  return {
    warnings,
    logger: {
      warn(payload: unknown, message: string) {
        warnings.push({ payload, message });
      }
    } as any
  };
}

function createPreparedMedia(mediaId = "file_table") {
  return {
    mediaId,
    inputUrl: `data:image/png;base64,${mediaId}`,
    kind: "image",
    animated: false,
    durationMs: null,
    sampledFrameCount: null
  };
}

test("media inspection service returns parsed answered results from the image inspector model", async () => {
  const calls: unknown[] = [];
  const llmClient = {
    isConfigured(modelRefs: string[]) {
      assert.deepEqual(modelRefs, ["primary", "secondary"]);
      return true;
    },
    async generate(params: {
      modelRefOverride: string[];
      timeoutMsOverride: number;
      enableThinkingOverride: boolean;
      preferNativeNoThinkingChatEndpoint: boolean;
      messages: Array<{ role: string; content: unknown }>;
    }) {
      calls.push(params);
      assert.deepEqual(params.modelRefOverride, ["primary", "secondary"]);
      assert.equal(params.timeoutMsOverride, 1234);
      assert.equal(params.enableThinkingOverride, false);
      assert.equal(params.preferNativeNoThinkingChatEndpoint, true);
      const userContent = params.messages[1]?.content;
      assert.ok(Array.isArray(userContent));
      assert.ok(userContent.some((item: any) => item.type === "text" && item.text.includes("读取金额列最大值")));
      assert.ok(userContent.some((item: any) => item.type === "image_url" && item.image_url.url.includes("file_table")));
      return {
        text: JSON.stringify({
          status: "answered",
          found: true,
          answer: "金额列最大值是 9800。",
          visibleContentSummary: "截图是 Excel 表格，列包括日期、客户、金额。",
          nearMatches: [],
          confidenceNotes: []
        }),
        usage: {
          modelRef: "primary"
        }
      };
    }
  } as any;

  const service = new MediaInspectionService(createInspectorConfig(), llmClient, createSilentLogger());
  const result = await service.inspectPreparedMedia({
    question: "读取金额列最大值",
    media: [createPreparedMedia()]
  });

  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.mediaId, "file_table");
  assert.equal(result.results[0]?.status, "answered");
  assert.equal(result.results[0]?.found, true);
  assert.equal(result.results[0]?.answer, "金额列最大值是 9800。");
  assert.equal(result.results[0]?.visibleContentSummary, "截图是 Excel 表格，列包括日期、客户、金额。");
  assert.equal(result.results[0]?.parseStatus, "parsed");
  assert.equal(result.results[0]?.modelRef, "primary");
});

test("media inspection service ignores non-vision inspector models and logs a warning", async () => {
  const logger = createRecordingLogger();
  const llmClient = {
    isConfigured(modelRefs: string[]) {
      assert.deepEqual(modelRefs, ["visual"]);
      return true;
    },
    async generate(params: { modelRefOverride: string[] }) {
      assert.deepEqual(params.modelRefOverride, ["visual"]);
      return {
        text: JSON.stringify({
          status: "answered",
          found: true,
          answer: "A1 是 日期。",
          visibleContentSummary: "截图是一张表格。",
          nearMatches: [],
          confidenceNotes: []
        }),
        usage: {
          modelRef: "visual"
        }
      };
    }
  } as any;

  const service = new MediaInspectionService(createMixedVisionInspectorConfig(), llmClient, logger.logger);
  const result = await service.inspectPreparedMedia({
    question: "读取 A1 单元格",
    media: [createPreparedMedia("file_mixed")]
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.modelRef, "visual");
  assert.equal(result.results[0]?.answer, "A1 是 日期。");
  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0]?.message, "vision_model_ref_ignored");
  assert.deepEqual((logger.warnings[0]?.payload as any).modelRefs, ["textOnly"]);
  assert.equal((logger.warnings[0]?.payload as any).role, "image_inspector");
});

test("media inspection service preserves not_found fallback content from fenced json", async () => {
  const llmClient = {
    isConfigured() {
      return true;
    },
    async generate() {
      return {
        text: [
          "```json",
          JSON.stringify({
            status: "not_found",
            found: false,
            answer: "图里没有看到订单号。",
            visibleContentSummary: "图中实际是一张任务清单截图，包含负责人、状态和截止日期。",
            nearMatches: ["有一列叫编号，但内容像任务编号"],
            confidenceNotes: ["右下角区域较模糊"]
          }),
          "```"
        ].join("\n"),
        usage: {
          modelRef: "secondary"
        }
      };
    }
  } as any;

  const service = new MediaInspectionService(createInspectorConfig(), llmClient, createSilentLogger());
  const result = await service.inspectPreparedMedia({
    question: "找到订单号",
    media: [createPreparedMedia("file_tasks")]
  });

  assert.equal(result.results[0]?.status, "not_found");
  assert.equal(result.results[0]?.found, false);
  assert.equal(result.results[0]?.visibleContentSummary, "图中实际是一张任务清单截图，包含负责人、状态和截止日期。");
  assert.deepEqual(result.results[0]?.nearMatches, ["有一列叫编号，但内容像任务编号"]);
  assert.deepEqual(result.results[0]?.confidenceNotes, ["右下角区域较模糊"]);
  assert.equal(result.results[0]?.parseStatus, "parsed");
  assert.equal(result.results[0]?.modelRef, "secondary");
});

test("media inspection service repairs lightly malformed json output", async () => {
  const llmClient = {
    isConfigured() {
      return true;
    },
    async generate() {
      return {
        text: "{status:'answered', found:true, answer:'总计是 42。', visibleContentSummary:'截图是一张统计表。', nearMatches:[], confidenceNotes:[],}",
        usage: {
          modelRef: "primary"
        }
      };
    }
  } as any;

  const service = new MediaInspectionService(createInspectorConfig(), llmClient, createSilentLogger());
  const result = await service.inspectPreparedMedia({
    question: "读取总计",
    media: [createPreparedMedia("file_repairable_json")]
  });

  assert.equal(result.results[0]?.status, "answered");
  assert.equal(result.results[0]?.found, true);
  assert.equal(result.results[0]?.answer, "总计是 42。");
  assert.equal(result.results[0]?.parseStatus, "repaired");
  assert.deepEqual(result.results[0]?.schemaIssues, []);
});

test("media inspection service limits concurrent per-image inspection calls", async () => {
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const llmClient = {
    isConfigured() {
      return true;
    },
    async generate(params: { messages: Array<{ role: string; content: unknown }> }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const userText = ((params.messages[1]?.content as any[]) ?? [])
        .find((item) => item.type === "text")?.text ?? "";
      const mediaId = String(userText).match(/media_id: ([^\n]+)/)?.[1] ?? "unknown";
      started.push(mediaId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        text: JSON.stringify({
          status: "answered",
          found: true,
          answer: `已读取 ${mediaId}`,
          visibleContentSummary: "截图是一张表。",
          nearMatches: [],
          confidenceNotes: []
        }),
        usage: {
          modelRef: "primary"
        }
      };
    }
  } as any;

  const service = new MediaInspectionService(createInspectorConfig(), llmClient, createSilentLogger());
  const result = await service.inspectPreparedMedia({
    question: "读取编号",
    media: [
      createPreparedMedia("file_1"),
      createPreparedMedia("file_2"),
      createPreparedMedia("file_3"),
      createPreparedMedia("file_4")
    ]
  });

  assert.equal(result.results.length, 4);
  assert.deepEqual(result.results.map((item) => item.mediaId), ["file_1", "file_2", "file_3", "file_4"]);
  assert.deepEqual(started.sort(), ["file_1", "file_2", "file_3", "file_4"]);
  assert.equal(maxActive, 2);
});

test("media inspection service rejects not_found results without visible content summary", async () => {
  const llmClient = {
    isConfigured() {
      return true;
    },
    async generate() {
      return {
        text: JSON.stringify({
          status: "not_found",
          found: false,
          answer: "图里没有看到订单号。",
          visibleContentSummary: null,
          nearMatches: [],
          confidenceNotes: []
        }),
        usage: {
          modelRef: "primary"
        }
      };
    }
  } as any;

  const service = new MediaInspectionService(createInspectorConfig(), llmClient, createSilentLogger());
  const result = await service.inspectPreparedMedia({
    question: "找到订单号",
    media: [createPreparedMedia("file_missing_summary")]
  });

  assert.equal(result.results[0]?.status, "unstructured");
  assert.equal(result.results[0]?.found, null);
  assert.equal(result.results[0]?.parseStatus, "fallback_text");
  assert.deepEqual(result.results[0]?.schemaIssues, [
    "schema_validation_failed",
    "not_found_missing_visible_content_summary"
  ]);
});

test("media inspection service derives found from normalized status when model output conflicts", async () => {
  const llmClient = {
    isConfigured() {
      return true;
    },
    async generate() {
      return {
        text: JSON.stringify({
          status: "not_found",
          found: true,
          answer: "图里没有看到订单号。",
          visibleContentSummary: "图中实际是一张库存表，包含 SKU、数量和仓位。",
          nearMatches: [],
          confidenceNotes: []
        }),
        usage: {
          modelRef: "primary"
        }
      };
    }
  } as any;

  const service = new MediaInspectionService(createInspectorConfig(), llmClient, createSilentLogger());
  const result = await service.inspectPreparedMedia({
    question: "找到订单号",
    media: [createPreparedMedia("file_conflicting_found")]
  });

  assert.equal(result.results[0]?.status, "not_found");
  assert.equal(result.results[0]?.found, false);
  assert.equal(result.results[0]?.parseStatus, "parsed");
  assert.deepEqual(result.results[0]?.schemaIssues, []);
});

test("media inspection service returns unstructured fallback when model output is not valid json", async () => {
  const llmClient = {
    isConfigured() {
      return true;
    },
    async generate() {
      return {
        text: "我看到了一个表格，但没法按 JSON 输出。表格里有日期、金额和状态列。",
        usage: {
          modelRef: "primary"
        }
      };
    }
  } as any;

  const service = new MediaInspectionService(createInspectorConfig(), llmClient, createSilentLogger());
  const result = await service.inspectPreparedMedia({
    question: "读取订单号",
    media: [createPreparedMedia("file_bad_json")]
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.mediaId, "file_bad_json");
  assert.equal(result.results[0]?.status, "unstructured");
  assert.equal(result.results[0]?.found, null);
  assert.match(result.results[0]?.answer ?? "", /原始识别内容/);
  assert.equal(result.results[0]?.rawAnswer, "我看到了一个表格，但没法按 JSON 输出。表格里有日期、金额和状态列。");
  assert.equal(result.results[0]?.parseStatus, "fallback_text");
  assert.deepEqual(result.results[0]?.schemaIssues, ["json_parse_failed"]);
  assert.ok(result.results[0]?.confidenceNotes.some((item) => item.includes("未通过结构化校验")));
});

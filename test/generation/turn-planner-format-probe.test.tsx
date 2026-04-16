import assert from "node:assert/strict";
import {
  buildTurnPlannerFormatProbePrompt,
  createDefaultTurnPlannerProbeCases,
  createProbeToolset,
  createTurnPlannerFormatProbeExecutor,
  evaluateTurnPlannerProbeSemantics,
  parseTurnPlannerProbeResponse,
  renderTurnPlannerProbeReport,
  runTurnPlannerFormatProbe,
  summarizeTurnPlannerProbeResults,
  type TurnPlannerProbeCaseResult
} from "../../src/app/generation/turnPlannerFormatProbe.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("parseTurnPlannerProbeResponse extracts fixed-format fields", async () => {
    const parsed = parseTurnPlannerProbeResponse([
      "reason: 需要查外部信息",
      "reply_decision: reply_small",
      "topic_decision: continue_topic",
      "required_capabilities: external_info_lookup, web_navigation",
      "context_dependencies: none",
      "recent_domain_reuse: web_research",
      "followup_mode: elliptical",
      "toolset_ids: web_research"
    ].join("\n"));

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data?.requiredCapabilities, ["external_info_lookup", "web_navigation"]);
    assert.equal(parsed.data?.toolsetIds[0], "web_research");
  });

  await runCase("parseTurnPlannerProbeResponse normalizes wait decisions to continue_topic", async () => {
    const parsed = parseTurnPlannerProbeResponse([
      "reason: 明显半句话未完",
      "reply_decision: wait",
      "topic_decision: new_topic",
      "required_capabilities: none",
      "context_dependencies: none",
      "recent_domain_reuse: none",
      "followup_mode: none",
      "toolset_ids: none"
    ].join("\n"));

    assert.equal(parsed.ok, true);
    assert.equal(parsed.rawData?.topicDecision, "new_topic");
    assert.equal(parsed.data?.replyDecision, "wait");
    assert.equal(parsed.data?.topicDecision, "continue_topic");
    assert.deepEqual(parsed.data?.normalizationWarnings, ["wait_forces_continue_topic"]);
  });

  await runCase("parseTurnPlannerProbeResponse adds obvious semantic toolset corrections", async () => {
    const parsed = parseTurnPlannerProbeResponse([
      "reason: 需要看引用并下载页面文件",
      "reply_decision: reply_small",
      "topic_decision: continue_topic",
      "required_capabilities: web_navigation, local_file_access",
      "context_dependencies: structured_message_context",
      "recent_domain_reuse: none",
      "followup_mode: explicit_reference",
      "toolset_ids: web_research"
    ].join("\n"));

    assert.equal(parsed.ok, true);
    assert.deepEqual(
      parsed.data?.toolsetIds,
      ["web_research", "local_file_io"]
    );
    assert.deepEqual(
      parsed.data?.normalizationWarnings,
      ["capability_requires_local_file_io"]
    );
  });

  await runCase("runTurnPlannerFormatProbe only auto-adds chat_context for real structured batch content", async () => {
    const result = await runTurnPlannerFormatProbe({
      modelRef: ["lms_qwen35_a3b"],
      availableToolsets: [createProbeToolset("web_research"), createProbeToolset("chat_context")],
      cases: [
        {
          id: "plain-explicit-reference",
          title: "普通显式指代",
          recentMessages: [],
          batchMessages: [{
            senderName: "Tester",
            text: "就这个继续说",
            images: [],
            audioSources: [],
            imageIds: [],
            emojiIds: [],
            attachments: [],
            forwardIds: [],
            replyMessageId: null,
            mentionUserIds: [],
            mentionedAll: false,
            mentionedSelf: false,
            timestampMs: Date.now()
          }],
          chatType: "private",
          relationship: "owner",
          currentUserSpecialRole: null
        },
        {
          id: "reply-reference",
          title: "真实 reply 上下文",
          recentMessages: [],
          batchMessages: [{
            senderName: "Tester",
            text: "接着这个说",
            images: [],
            audioSources: [],
            imageIds: [],
            emojiIds: [],
            attachments: [],
            forwardIds: [],
            replyMessageId: "msg-1",
            mentionUserIds: [],
            mentionedAll: false,
            mentionedSelf: false,
            timestampMs: Date.now()
          }],
          chatType: "private",
          relationship: "owner",
          currentUserSpecialRole: null
        }
      ],
      executePrompt: async ({ probeCase }) => (
        probeCase.id === "plain-explicit-reference"
          ? [
              "reason: 指向前文",
              "reply_decision: reply_small",
              "topic_decision: continue_topic",
              "required_capabilities: none",
              "context_dependencies: structured_message_context",
              "recent_domain_reuse: none",
              "followup_mode: explicit_reference",
              "toolset_ids: web_research"
            ].join("\n")
          : [
              "reason: 需要展开 reply",
              "reply_decision: reply_small",
              "topic_decision: continue_topic",
              "required_capabilities: none",
              "context_dependencies: structured_message_context",
              "recent_domain_reuse: none",
              "followup_mode: explicit_reference",
              "toolset_ids: web_research"
            ].join("\n")
      )
    });

    const plain = result.results.find((item) => item.caseId === "plain-explicit-reference");
    const reply = result.results.find((item) => item.caseId === "reply-reference");
    assert.equal(plain?.parse.ok, true);
    assert.equal(reply?.parse.ok, true);
    if (plain?.parse.ok) {
      assert.deepEqual(plain.parse.data.toolsetIds, ["web_research"]);
      assert.doesNotMatch(plain.parse.data.normalizationWarnings.join(","), /structured_context_requires_chat_context/);
    }
    if (reply?.parse.ok) {
      assert.deepEqual(reply.parse.data.toolsetIds, ["web_research", "chat_context"]);
      assert.match(reply.parse.data.normalizationWarnings.join(","), /structured_context_requires_chat_context/);
    }
  });

  await runCase("summarizeTurnPlannerProbeResults counts format failures", async () => {
    const summary = summarizeTurnPlannerProbeResults([
      {
        caseId: "ok-case",
        rawText: "reason: ok",
        parse: {
          ok: true,
          data: {
            reason: "ok",
            replyDecision: "reply_small",
            topicDecision: "continue_topic",
            requiredCapabilities: [],
            contextDependencies: [],
            recentDomainReuse: [],
            followupMode: "none",
            toolsetIds: []
          }
        }
      },
      {
        caseId: "bad-case",
        rawText: "garbled",
        parse: {
          ok: false,
          error: "missing reason"
        }
      }
    ] satisfies TurnPlannerProbeCaseResult[]);

    assert.equal(summary.totalCases, 2);
    assert.equal(summary.okCases, 1);
    assert.equal(summary.failedCases, 1);
    assert.deepEqual(summary.failedCaseIds, ["bad-case"]);
  });

  await runCase("runTurnPlannerFormatProbe preserves per-case raw output and parse status", async () => {
    const result = await runTurnPlannerFormatProbe({
      modelRef: ["lms_qwen35_a3b"],
      availableToolsets: [createProbeToolset("web_research")],
      cases: [
        {
          id: "web-followup",
          title: "网页跟进",
          recentMessages: [{
            role: "assistant",
            content: "我先打开这个页面看看。",
            timestampMs: Date.now() - 5000
          }],
          batchMessages: [{
            senderName: "Tester",
            text: "继续，点进去看看",
            images: [],
            audioSources: [],
            imageIds: [],
            emojiIds: [],
            attachments: [],
            forwardIds: [],
            replyMessageId: null,
            mentionUserIds: [],
            mentionedAll: false,
            mentionedSelf: false,
            timestampMs: Date.now()
          }],
          chatType: "private",
          relationship: "owner",
          currentUserSpecialRole: null
        }
      ],
      executePrompt: async () => [
        "reason: 延续网页操作",
        "reply_decision: reply_small",
        "topic_decision: continue_topic",
        "required_capabilities: web_navigation",
        "context_dependencies: prior_web_context",
        "recent_domain_reuse: web_research",
        "followup_mode: elliptical",
        "toolset_ids: web_research"
      ].join("\n")
    });

    assert.equal(result.results[0]?.caseId, "web-followup");
    assert.equal(result.results[0]?.parse.ok, true);
    assert.equal(result.results[0]?.semantic?.ok, true);
    assert.equal(result.summary.okCases, 1);
  });

  await runCase("createDefaultTurnPlannerProbeCases covers representative planner scenarios", async () => {
    const cases = createDefaultTurnPlannerProbeCases();
    assert.equal(cases.length >= 12, true);
    assert.equal(cases.some((item) => item.id === "web-download"), true);
    assert.equal(cases.some((item) => item.id === "shell-debug"), true);
    assert.equal(cases.some((item) => item.id === "unfinished-wait"), true);
    assert.equal(cases.some((item) => item.id === "conversation-navigation"), true);
    assert.equal(cases.some((item) => item.id === "chat-delegation"), true);
    assert.equal(cases.some((item) => item.id === "structured-forward-context"), true);
  });

  await runCase("evaluateTurnPlannerProbeSemantics reports mismatched required toolsets", async () => {
    const evaluation = evaluateTurnPlannerProbeSemantics({
      id: "structured-context",
      title: "结构化上下文补全",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [],
      expectations: {
        requiredToolsetIds: ["chat_context"],
        expectedReplyDecisions: ["reply_small", "reply_large"],
        expectedTopicDecisions: ["continue_topic"]
      }
    }, {
      reason: "先看上下文",
      replyDecision: "reply_small",
      topicDecision: "continue_topic",
      requiredCapabilities: [],
      contextDependencies: [],
      recentDomainReuse: [],
      followupMode: "explicit_reference",
      toolsetIds: ["web_research"],
      normalizationWarnings: []
    });

    assert.equal(evaluation.ok, false);
    assert.deepEqual(evaluation.issues, ["missing_required_toolset:chat_context"]);
  });

  await runCase("renderTurnPlannerProbeReport prints summary and failed cases", async () => {
    const report = renderTurnPlannerProbeReport({
      modelRef: ["lms_qwen35_a3b"],
      summary: {
        totalCases: 2,
        okCases: 1,
        failedCases: 1,
        failedCaseIds: ["bad-case"]
      },
      results: [
        {
          caseId: "ok-case",
          rawText: "reason: ok",
          parse: {
            ok: true,
            rawData: {
              reason: "ok",
              replyDecision: "reply_small",
              topicDecision: "continue_topic",
              requiredCapabilities: [],
              contextDependencies: [],
              recentDomainReuse: [],
              followupMode: "none",
              toolsetIds: [],
              normalizationWarnings: []
            },
            data: {
              reason: "ok",
              replyDecision: "reply_small",
              topicDecision: "continue_topic",
              requiredCapabilities: [],
              contextDependencies: [],
              recentDomainReuse: [],
              followupMode: "none",
              toolsetIds: [],
              normalizationWarnings: []
            }
          },
          semantic: {
            ok: true,
            issues: []
          }
        },
        {
          caseId: "bad-case",
          rawText: "garbled",
          parse: {
            ok: false,
            error: "missing reason"
          }
        }
      ]
    });

    assert.match(report, /lms_qwen35_a3b/);
    assert.match(report, /failed=1/);
    assert.match(report, /bad-case/);
  });

  await runCase("renderTurnPlannerProbeReport prints normalization warnings when applied", async () => {
    const report = renderTurnPlannerProbeReport({
      modelRef: ["lms_qwen35_a3b"],
      summary: {
        totalCases: 1,
        okCases: 1,
        failedCases: 0,
        failedCaseIds: []
      },
      results: [
        {
          caseId: "unfinished-wait",
          rawText: "reason: 明显半句话未完",
          parse: {
            ok: true,
            rawData: {
              reason: "明显半句话未完",
              replyDecision: "wait",
              topicDecision: "new_topic",
              requiredCapabilities: [],
              contextDependencies: [],
              recentDomainReuse: [],
              followupMode: "none",
              toolsetIds: [],
              normalizationWarnings: []
            },
            data: {
              reason: "明显半句话未完",
              replyDecision: "wait",
              topicDecision: "continue_topic",
              requiredCapabilities: [],
              contextDependencies: [],
              recentDomainReuse: [],
              followupMode: "none",
              toolsetIds: [],
              normalizationWarnings: ["wait_forces_continue_topic"]
            }
          },
          semantic: {
            ok: true,
            issues: []
          }
        }
      ]
    });

    assert.match(report, /warning=wait_forces_continue_topic/);
    assert.match(report, /raw_topic=new_topic/);
    assert.match(report, /semantic=ok/);
  });

  await runCase("createTurnPlannerFormatProbeExecutor disables thinking for stable format probes", async () => {
    let capturedEnableThinking: boolean | undefined;
    let capturedTools: unknown;
    const executor = createTurnPlannerFormatProbeExecutor({
      client: {
        async generate(params) {
          capturedEnableThinking = params.enableThinkingOverride;
          capturedTools = params.tools;
          return {
            text: "reason: ok",
            reasoningContent: "",
            usage: {
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              cachedTokens: null,
              reasoningTokens: null,
              requestCount: 1,
              providerReported: false,
              modelRef: "lms_qwen35_a3b",
              model: "fake"
            }
          };
        }
      }
    });

    await executor({
      modelRef: ["lms_qwen35_a3b"],
      probeCase: createDefaultTurnPlannerProbeCases()[0]!,
      availableToolsets: [createProbeToolset("web_research")],
      promptMessages: [{ role: "system", content: "test" }]
    });

    assert.equal(capturedEnableThinking, false);
    assert.equal(capturedTools, undefined);
  });

  await runCase("buildTurnPlannerFormatProbePrompt removes the legacy pipe-format instruction", async () => {
    const messages = buildTurnPlannerFormatProbePrompt(
      createDefaultTurnPlannerProbeCases()[0]!,
      [createProbeToolset("web_research")]
    );
    const systemMessage = messages.find((item) => item.role === "system");
    assert.equal(typeof systemMessage?.content, "string");
    assert.doesNotMatch(
      String(systemMessage?.content),
      /输出格式严格单行：简短理由\|<动作标签>\|<话题标签>\|<工具集ID列表>/
    );
    assert.match(
      String(systemMessage?.content),
      /必须严格输出下面 8 行/
    );
  });
}

void main();

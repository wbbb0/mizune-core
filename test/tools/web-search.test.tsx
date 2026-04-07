import assert from "node:assert/strict";
import { webToolHandlers } from "../../src/llm/tools/web/webTools.ts";
import { runCase } from "../helpers/forward-test-support.tsx";
import { createFunctionToolCall, parseJsonToolResult } from "../helpers/tool-test-support.tsx";

async function main() {
  await runCase("ground_with_google_search returns provider result", async () => {
    const result = await webToolHandlers.ground_with_google_search!(
      createFunctionToolCall("ground_with_google_search", "tool_4"),
      { query: "OpenAI" },
      {
        searchService: {
          async searchGoogleGrounding(query: string) {
            return {
              ok: true,
              provider: "google_grounding",
              query,
              answer: "summary",
              webSearchQueries: ["OpenAI"],
              results: [{
                ref_id: "search_1",
                title: "OpenAI",
                url: "https://openai.com",
                redirectUrl: "https://vertexaisearch.cloud.google.com/redirect/1",
                host: "openai.com",
                snippet: null,
                summary: null,
                publishedTime: null,
                mainText: null,
                markdownText: null,
                siteName: null,
                score: null,
                images: []
              }],
              responseId: "resp_1",
              modelVersion: "gemini-2.5-flash",
              usage: {
                promptTokenCount: 1,
                candidatesTokenCount: 2,
                totalTokenCount: 3,
                toolUsePromptTokenCount: 4,
                thoughtsTokenCount: 5,
                searchTimeMs: null
              },
              meta: null
            };
          }
        } as any
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.results[0].url, "https://openai.com");
    assert.equal(parsed.results[0].ref_id, "search_1");
  });

  await runCase("search_with_iqs_lite_advanced returns provider result", async () => {
    const result = await webToolHandlers.search_with_iqs_lite_advanced!(
      createFunctionToolCall("search_with_iqs_lite_advanced", "tool_5"),
      { query: "OpenAI", num_results: 3, include_sites: ["openai.com"] },
      {
        searchService: {
          async searchAliyunIqsLiteAdvanced(query: string, options: Record<string, unknown>) {
            assert.equal(query, "OpenAI");
            assert.deepEqual(options.includeSites, ["openai.com"]);
            return {
              ok: true,
              provider: "aliyun_iqs_lite_advanced",
              query,
              answer: null,
              webSearchQueries: [],
              results: [{
                ref_id: "search_2",
                title: "OpenAI",
                url: "https://openai.com",
                redirectUrl: null,
                host: "openai.com",
                snippet: "OpenAI homepage",
                summary: null,
                publishedTime: "2026-03-24T00:00:00+08:00",
                mainText: null,
                markdownText: null,
                siteName: "OpenAI",
                score: 0.99,
                images: []
              }],
              responseId: "aliyun_req_1",
              modelVersion: "LiteAdvanced",
              usage: {
                promptTokenCount: null,
                candidatesTokenCount: null,
                totalTokenCount: null,
                toolUsePromptTokenCount: null,
                thoughtsTokenCount: null,
                searchTimeMs: 123
              },
              meta: {
                sceneItems: [],
                searchInformation: { searchTime: 123 }
              }
            };
          }
        } as any
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.provider, "aliyun_iqs_lite_advanced");
    assert.equal(parsed.results[0].siteName, "OpenAI");
    assert.equal(parsed.results[0].ref_id, "search_2");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

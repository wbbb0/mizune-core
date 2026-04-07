import assert from "node:assert/strict";
import { createTestAppConfig } from "./config-fixtures.tsx";
import type { LlmMessage, LlmToolDefinition } from "../../src/llm/provider/providerTypes.ts";

export function createLlmTestConfig(modelOverrides: any = {}) {
  const baseModel = {
    provider: "test",
    model: "fake-model",
    supportsThinking: true,
    supportsVision: false,
    supportsSearch: false,
    supportsTools: true,
    forceNoThinkDirective: false,
    returnReasoningContentForAllMessages: false,
    returnReasoningContentForSameRoundMessages: true
  };
  const fallbackModels = Array.isArray(modelOverrides)
    ? Object.fromEntries(modelOverrides.map((override, index) => [
        index === 0 ? "main" : `candidate_${index + 1}`,
        {
          ...baseModel,
          ...override
        }
      ]))
    : {
        main: {
          ...baseModel,
          ...modelOverrides
        }
      };

  return createTestAppConfig({
    llm: {
      enabled: true,
      mainRouting: {
        smallModelRef: Array.isArray(modelOverrides)
          ? Object.keys(fallbackModels)
          : ["main"],
        largeModelRef: ["main"],
        enableThinking: true
      },
      models: fallbackModels,
      toolCallMaxIterations: 4
    },
    search: {
      googleGrounding: {
        enabled: false
      }
    },
    browser: {
      enabled: false
    }
  });
}

export function createToolDefinition(name: string): LlmToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  };
}

export function createSseResponse(payloads: any[]) {
  const encoder = new TextEncoder();
  const raw = [
    ...payloads.map((payload: any) => `data: ${JSON.stringify(payload)}\n\n`),
    "data: [DONE]\n\n"
  ].join("");

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      }
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream"
      }
    }
  );
}

export async function withMockFetch(scenarios: any[], fn: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;

  globalThis.fetch = async (url, init = {}) => {
    const scenario = scenarios[callIndex];
    assert.ok(scenario, `unexpected fetch call #${callIndex + 1}`);
    const body = JSON.parse(String(init.body ?? "{}"));
    scenario.assertRequest(body, callIndex, init, String(url));
    callIndex += 1;
    if (scenario.error) {
      throw scenario.error;
    }
    if (scenario.response) {
      return scenario.response;
    }
    return createSseResponse(scenario.payloads);
  };

  try {
    await fn();
    assert.equal(callIndex, scenarios.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

export function createToolCallPayload(reasoningContent: string) {
  return [
    {
      choices: [{
        delta: {
          reasoning_content: reasoningContent
        }
      }]
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "tool-call-1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{\"query\":\"weather\"}"
            }
          }]
        }
      }]
    },
    {
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18
      }
    }
  ];
}

export function createAssistantToolRoundtripMessages(): LlmMessage[] {
  return [
    { role: "user", content: "continue the task" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "tool-call-1",
        type: "function",
        function: {
          name: "lookup",
          arguments: "{\"query\":\"test\"}"
        }
      }]
    },
    {
      role: "tool",
      tool_call_id: "tool-call-1",
      content: "{\"ok\":true}"
    }
  ];
}

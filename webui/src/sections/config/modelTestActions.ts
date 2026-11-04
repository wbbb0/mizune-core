import type { EditorNodeActions } from "@workbench-kit/vue";

export interface ModelTestWindowInput {
  providerName: string;
  modelName: string;
  provider: Record<string, unknown>;
  model: Record<string, unknown>;
}

/** Resolve the current draft on click, then freeze the request context for the test window. */
export function createModelTestNodeActions(input: {
  getResourceKey: () => string | null;
  getDraft: () => unknown;
  openTest: (context: ModelTestWindowInput) => void;
}): EditorNodeActions {
  return ({ node, path }) => {
    if (input.getResourceKey() !== "llm_catalog" || node.kind !== "group" || path.length !== 3 || path[1] !== "models") return [];
    const [providerName, , modelName] = path;
    if (typeof providerName !== "string" || typeof modelName !== "string") return [];
    return [{
      key: "test-model", icon: "play", label: "测试能力", title: "测试模型能力与连通性",
      onClick: () => {
        if (input.getResourceKey() !== "llm_catalog") return;
        const provider = object(object(input.getDraft())?.[providerName]);
        const model = object(object(provider?.models)?.[modelName]);
        if (!provider || !model) return;
        const { models: _models, ...connection } = provider;
        input.openTest({ providerName, modelName, provider: clone(connection), model: clone(model) });
      }
    }];
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function clone(value: Record<string, unknown>): Record<string, unknown> {
  // Configuration is JSON data; serialization also detaches nested Vue proxies.
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

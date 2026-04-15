import {
  createEmptyUsage,
  mergeUsage,
  type LlmToolCall,
  type LlmProviderGenerateParams,
  type LlmUsage
} from "./providerTypes.ts";

export interface IndexedToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ProviderStreamAccumulator {
  usage: LlmUsage;
  text: string;
  reasoningContent: string;
  sawReasoningContent: boolean;
  appendTextDelta: (delta: string, onTextDelta?: LlmProviderGenerateParams["onTextDelta"]) => Promise<void>;
  appendReasoningDelta: (delta: string, onReasoningDelta?: (delta: string) => void) => void;
  replaceUsage: (usage: LlmUsage) => void;
}

// Splits a buffered SSE string into complete events and the remaining partial tail.
export function splitSseEvents(buffer: string): { events: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const segments = normalized.split("\n\n");
  const remainder = segments.pop() ?? "";
  return {
    events: segments,
    remainder
  };
}

// Extracts all data payload lines from a single SSE event block.
export function extractSseDataLines(event: string): string[] {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
}

// Builds a provider-reported usage snapshot with consistent defaults.
export function createReportedUsage(input: {
  modelRef: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  providerReported?: boolean;
}): LlmUsage {
  return mergeUsage(createEmptyUsage(input.modelRef, input.model), {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
    cachedTokens: input.cachedTokens ?? 0,
    reasoningTokens: input.reasoningTokens ?? 0,
    requestCount: 1,
    providerReported: input.providerReported ?? true,
    modelRef: input.modelRef,
    model: input.model
  });
}

// Tracks the common streamed text, reasoning, and usage state for a provider response.
export function createProviderStreamAccumulator(input: {
  modelRef: string;
  model: string;
}): ProviderStreamAccumulator {
  return {
    usage: createEmptyUsage(input.modelRef, input.model),
    text: "",
    reasoningContent: "",
    sawReasoningContent: false,
    async appendTextDelta(delta, onTextDelta) {
      if (!delta) {
        return;
      }
      this.text += delta;
      await onTextDelta?.(delta);
    },
    appendReasoningDelta(delta, onReasoningDelta) {
      if (!delta) {
        return;
      }
      this.sawReasoningContent = true;
      this.reasoningContent += delta;
      onReasoningDelta?.(delta);
    },
    replaceUsage(usage) {
      this.usage = usage;
    }
  };
}

// Appends streamed function-call deltas into stable indexed tool-call objects.
export function mergeIndexedToolCallDeltas(
  target: Map<number, LlmToolCall>,
  deltas: IndexedToolCallDelta[],
  idPrefix = "tool_call"
): void {
  for (const toolCallDelta of deltas) {
    const index = toolCallDelta.index ?? 0;
    const existing = target.get(index) ?? {
      id: toolCallDelta.id ?? `${idPrefix}_${index}`,
      type: "function" as const,
      function: {
        name: "",
        arguments: ""
      }
    };

    if (toolCallDelta.id) {
      existing.id = toolCallDelta.id;
    }
    if (toolCallDelta.function?.name) {
      existing.function.name = toolCallDelta.function.name;
    }
    if (toolCallDelta.function?.arguments) {
      existing.function.arguments += toolCallDelta.function.arguments;
    }

    target.set(index, existing);
  }
}
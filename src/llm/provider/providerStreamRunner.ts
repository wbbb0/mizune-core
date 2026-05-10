import { fetchWithProxy } from "#services/proxy/index.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "./providerTimeout.ts";
import {
  createProviderStreamAccumulator,
  extractSseDataLines,
  splitSseEvents,
  type ProviderStreamAccumulator
} from "./providerStreamAdapter.ts";
import type {
  LlmProviderGenerateParams,
  LlmProviderRequestContext,
  LlmUsage
} from "./providerTypes.ts";

export type ProviderSseSemanticEvent<TFinalPayload> =
  | { kind: "reasoning_delta"; text: string }
  | { kind: "text_delta"; text: string }
  | { kind: "usage"; usage: LlmUsage }
  | { kind: "final"; payload: TFinalPayload }
  | { kind: "first_response" };

export interface ProviderSseStreamResult<TFinalPayload> {
  accumulator: ProviderStreamAccumulator;
  finalPayload: TFinalPayload | null;
}

export async function runProviderSseStream<TFinalPayload>(input: {
  context: LlmProviderRequestContext;
  params: LlmProviderGenerateParams;
  endpoint: string;
  requestBody: Record<string, unknown>;
  resolvedTimeoutMs: number;
  parseData: (data: string) => ProviderSseSemanticEvent<TFinalPayload>[] | Promise<ProviderSseSemanticEvent<TFinalPayload>[]>;
  errorPrefix?: string;
}): Promise<ProviderSseStreamResult<TFinalPayload>> {
  const timeoutController = createProviderTimeoutController({
    totalTimeoutMs: input.resolvedTimeoutMs,
    firstTokenTimeoutMs: input.context.config.llm.firstTokenTimeoutMs,
    thinkingTimeoutMs: input.context.config.llm.thinkingTimeoutMs
  });
  const forwardAbort = () => timeoutController.controller.abort();
  input.params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetchWithProxy(input.context.config, "llm", input.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.context.providerConfig.apiKey ?? ""}`
      },
      body: JSON.stringify(input.requestBody),
      signal: timeoutController.controller.signal
    }, {
      modelRef: input.context.modelRef
    });

    if (!response.ok) {
      const errorText = await response.text();
      const prefix = input.errorPrefix ?? "LLM API error";
      throw new Error(`${prefix}: ${response.status} ${response.statusText}${errorText ? ` ${errorText}` : ""}`);
    }

    if (!response.body) {
      throw new Error("LLM stream body is missing");
    }

    return await consumeSseStream({
      params: input.params,
      response,
      parseData: input.parseData,
      markFirstResponseReceived: () => timeoutController.markFirstResponseReceived(),
      markReasoningStarted: () => timeoutController.markReasoningStarted(),
      markFirstTextReceived: () => timeoutController.markFirstTextReceived(),
      accumulator: createProviderStreamAccumulator({
        modelRef: input.context.modelRef,
        model: input.context.model
      })
    });
  } catch (error) {
    if (timeoutController.controller.signal.aborted) {
      rethrowProviderAbortReason(timeoutController.controller.signal, error);
    }
    throw error;
  } finally {
    timeoutController.cleanup();
    input.params.abortSignal?.removeEventListener("abort", forwardAbort);
  }
}

async function consumeSseStream<TFinalPayload>(input: {
  params: LlmProviderGenerateParams;
  response: Awaited<ReturnType<typeof fetchWithProxy>>;
  parseData: (data: string) => ProviderSseSemanticEvent<TFinalPayload>[] | Promise<ProviderSseSemanticEvent<TFinalPayload>[]>;
  markFirstResponseReceived: () => void;
  markReasoningStarted: () => void;
  markFirstTextReceived: () => void;
  accumulator: ProviderStreamAccumulator;
}): Promise<ProviderSseStreamResult<TFinalPayload>> {
  const reader = input.response.body!.getReader();
  const decoder = new TextDecoder("utf8");
  let sseBuffer = "";
  const finalPayloadRef: { current: TFinalPayload | null } = { current: null };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    sseBuffer += decoder.decode(value, { stream: true });
    const parsed = splitSseEvents(sseBuffer);
    sseBuffer = parsed.remainder;

    for (const event of parsed.events) {
      await processSseEvent({
        ...input,
        event,
        setFinalPayload: (payload) => {
          finalPayloadRef.current = payload;
        }
      });
    }
  }

  const trailing = sseBuffer.trim();
  if (trailing.length > 0) {
    await processSseEvent({
      ...input,
      event: trailing,
      setFinalPayload: (payload) => {
        finalPayloadRef.current = payload;
      }
    });
  }

  return {
    accumulator: input.accumulator,
    finalPayload: finalPayloadRef.current
  };
}

async function processSseEvent<TFinalPayload>(input: {
  params: LlmProviderGenerateParams;
  event: string;
  parseData: (data: string) => ProviderSseSemanticEvent<TFinalPayload>[] | Promise<ProviderSseSemanticEvent<TFinalPayload>[]>;
  markFirstResponseReceived: () => void;
  markReasoningStarted: () => void;
  markFirstTextReceived: () => void;
  accumulator: ProviderStreamAccumulator;
  setFinalPayload: (payload: TFinalPayload) => void;
}): Promise<void> {
  for (const data of extractSseDataLines(input.event)) {
    const events = await input.parseData(data);
    for (const event of events) {
      await applySemanticStreamEvent(input, event);
    }
  }
}

async function applySemanticStreamEvent<TFinalPayload>(
  input: {
    params: LlmProviderGenerateParams;
    markFirstResponseReceived: () => void;
    markReasoningStarted: () => void;
    markFirstTextReceived: () => void;
    accumulator: ProviderStreamAccumulator;
    setFinalPayload: (payload: TFinalPayload) => void;
  },
  event: ProviderSseSemanticEvent<TFinalPayload>
): Promise<void> {
  if (event.kind === "reasoning_delta") {
    input.markFirstResponseReceived();
    input.markReasoningStarted();
    input.accumulator.appendReasoningDelta(event.text, input.params.onReasoningDelta);
    return;
  }
  if (event.kind === "text_delta") {
    input.markFirstResponseReceived();
    input.markFirstTextReceived();
    await input.accumulator.appendTextDelta(event.text, input.params.onTextDelta);
    return;
  }
  if (event.kind === "usage") {
    input.accumulator.replaceUsage(event.usage);
    return;
  }
  if (event.kind === "final") {
    input.markFirstResponseReceived();
    input.markFirstTextReceived();
    input.setFinalPayload(event.payload);
    return;
  }
  input.markFirstResponseReceived();
}

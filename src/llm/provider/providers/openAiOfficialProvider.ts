import { OpenAiResponsesProvider } from "./openAiResponsesProvider.ts";
import { requestOpenAiTranscription, requestOpenAiSpeech } from "../openAiNativeAudio.ts";
import { requestOpenAiDecision } from "../openAiNativeDecision.ts";
import type { LlmProviderRequestContext } from "../providerTypes.ts";
import type {
  LlmTranscribeParams,
  LlmTranscribeResult,
  LlmSynthesizeParams,
  LlmSynthesizeResult,
  LlmDecideParams,
  LlmDecideResult
} from "../nativeCapabilityTypes.ts";

/** Official OpenAI capabilities share authentication, transport, and model routing. */
export class OpenAiOfficialProvider extends OpenAiResponsesProvider {
  readonly type = "openai" as const;

  transcribe(context: LlmProviderRequestContext, params: LlmTranscribeParams): Promise<LlmTranscribeResult> {
    return requestOpenAiTranscription(context, params);
  }

  synthesize(context: LlmProviderRequestContext, params: LlmSynthesizeParams): Promise<LlmSynthesizeResult> {
    return requestOpenAiSpeech(context, params);
  }

  decide(context: LlmProviderRequestContext, params: LlmDecideParams): Promise<LlmDecideResult> {
    return requestOpenAiDecision(context, params);
  }
}

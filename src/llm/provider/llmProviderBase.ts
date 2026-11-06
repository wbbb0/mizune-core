import type { LlmProvider } from "./providerTypes.ts";
import type { ModelDiscoveryInput, NativeModelDiscoveryResult } from "./modelDiscoveryTypes.ts";
import { fetchNativeProviderModels } from "./nativeModelDiscovery.ts";
import { modelsDevCatalog } from "./modelsDevCatalog.ts";

/** 原生清单确定可用模型；公共目录仅补齐缺失的元信息。 */
export abstract class LlmProviderBase implements LlmProvider {
  abstract readonly type: LlmProvider["type"];
  abstract resolveBaseUrl(config: Parameters<LlmProvider["resolveBaseUrl"]>[0]): string | null;
  abstract generate(context: Parameters<LlmProvider["generate"]>[0], params: Parameters<LlmProvider["generate"]>[1]): ReturnType<LlmProvider["generate"]>;

  protected discoverNativeModels(input: ModelDiscoveryInput): Promise<NativeModelDiscoveryResult> {
    return fetchNativeProviderModels(input);
  }

  async discoverModels(input: ModelDiscoveryInput): Promise<NativeModelDiscoveryResult> {
    const callerSignal = input.abortSignal;
    callerSignal?.throwIfAborted();
    const deadline = AbortSignal.timeout(input.fetchTimeoutMs ?? 15000);
    input = { ...input, abortSignal: callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline };
    const result = await this.discoverNativeModels(input);
    if (result.kind !== "ok" || result.models.length === 0) return result;
    try { return await modelsDevCatalog.enrich(result, input); }
    catch (error) {
      // 外部取消仍终止整个操作；可选补齐耗尽预算时保留已成功的原生清单。
      callerSignal?.throwIfAborted();
      if (!deadline.aborted) throw error;
      return { ...result, warnings: [...result.warnings, "模型元信息补齐等待超时，已保留原生模型信息"] };
    }
  }
}

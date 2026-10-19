import type { ModelProfile, LlmProviderConfig } from "#config/configModel.ts";

export function buildImageRequestParameters(profile: ModelProfile, provider: LlmProviderConfig, size?: string): Record<string, unknown> {
  const settings = profile.image;
  if (!settings) throw new Error("模型未配置图像用途");
  const defaults = settings.defaults;
  const result: Record<string, unknown> = { ...defaults };
  if (size) result.size = size;
  if (provider.type === "openrouter") {
    if (result.size) throw new Error("OpenRouter 图像接口使用比例与分辨率，请在模型默认参数中设置 aspect_ratio 和 resolution，不使用 size");
    if (result.response_format) throw new Error("OpenRouter 图像接口不使用 response_format，请清除此默认参数");
  } else if (result.aspect_ratio || result.resolution || result.seed !== undefined) {
    throw new Error("当前 Images 兼容接口不支持 OpenRouter 专用的比例、分辨率或种子参数");
  }
  const mappings = { size: "sizes", aspect_ratio: "aspectRatios", resolution: "resolutions", quality: "qualities" } as const;
  for (const [field, constraint] of Object.entries(mappings)) {
    const choices = settings.constraints[constraint];
    if (result[field] !== undefined && choices?.length && !choices.includes(String(result[field]))) {
      throw new Error(`图像参数 ${field} 不在模型声明的选项中：${choices.join("、")}`);
    }
  }
  return result;
}

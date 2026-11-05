import type { ModelProfile, LlmProviderConfig } from "#config/configModel.ts";

export function buildImageRequestParameters(profile: ModelProfile, provider: LlmProviderConfig, size?: string, editing = false, overrides: { aspect_ratio?: string; resolution?: string; quality?: string; output_format?: string; frame_count?: number; frame_duration_ms?: number } = {}): Record<string, unknown> {
  const settings = profile.image;
  if (!settings) throw new Error("模型未配置图像用途");
  const defaults = settings.defaults;
  const result: Record<string, unknown> = { ...defaults, ...overrides };
  if (!editing) delete result.input_fidelity;
  if (size) result.size = size;
  if (provider.type === "google") {
    for (const key of Object.keys(result)) if (!["aspect_ratio", "resolution"].includes(key) && result[key] !== undefined) throw new Error(`Google 原生图像不支持参数 ${key}，请使用比例或分辨率配置`);
    validateImageParameterChoices(settings, result);
    return result;
  }
  if (provider.type === "openai" && result.response_format) {
    throw new Error("OpenAI 官方图像接口直接返回 Base64，不使用 response_format，请清除此默认参数");
  }
  if (provider.type === "openrouter") {
    if (result.size) throw new Error("OpenRouter 图像接口使用比例与分辨率，请在模型默认参数中设置 aspect_ratio 和 resolution，不使用 size");
    if (result.response_format) throw new Error("OpenRouter 图像接口不使用 response_format，请清除此默认参数");
  } else if (result.aspect_ratio || result.resolution || result.seed !== undefined) {
    throw new Error("当前 Images 兼容接口不支持 OpenRouter 专用的比例、分辨率或种子参数");
  }
  const gif = result.output_format === "gif";
  if (gif && editing) throw new Error("GIF 动图仅支持生成，不支持参考图编辑或局部重绘");
  if (gif && provider.type === "openrouter") throw new Error("当前 OpenRouter 图像协议未实现 GIF 生成");
  if (!gif && (result.frame_count !== undefined || result.frame_duration_ms !== undefined)) {
    throw new Error("frame_count 和 frame_duration_ms 仅可用于 GIF 输出");
  }
  if (gif && result.output_compression !== undefined) throw new Error("GIF 输出不支持 output_compression");
  for (const [key, min, max] of [["frame_count", 2, 64], ["frame_duration_ms", 20, 2000]] as const) {
    const value = result[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)) {
      throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的整数`);
    }
  }
  if (result.frame_duration_ms !== undefined) result.frame_duration_ms = Math.round(Number(result.frame_duration_ms) / 10) * 10;
  if (result.output_format !== undefined && !["png", "jpeg", "webp", "gif"].includes(String(result.output_format))) {
    throw new Error("输出格式必须为 png、jpeg、webp 或 gif");
  }
  validateImageParameterChoices(settings, result);
  return result;
}

function validateImageParameterChoices(settings: NonNullable<ModelProfile["image"]>, result: Record<string, unknown>): void {
  const mappings = { size: "sizes", aspect_ratio: "aspectRatios", resolution: "resolutions", quality: "qualities" } as const;
  for (const [field, constraint] of Object.entries(mappings)) {
    const choices = settings.constraints[constraint];
    if (result[field] !== undefined && choices?.length && !choices.includes(String(result[field]))) {
      throw new Error(`图像参数 ${field} 不在模型声明的选项中：${choices.join("、")}`);
    }
  }
}

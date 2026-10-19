# 图像生成配置

标准 Images API 和 ComfyUI 保持独立配置，复用图片资产系统，分别通过 `image_generation`（通用图片生成）与 `comfy_image`（ComfyUI 图片生成）工具集控制。

| 职责 | 标准图像模型 | ComfyUI |
| --- | --- | --- |
| 连接与凭据 | `llm.catalog.yml` 的 Provider | `comfy.apiBaseUrl` 等现有配置 |
| 可选目标 | Provider 内 `image` 子树 的模型 | `comfy.templates` 工作流模板 |
| 默认选择 | 当前路由预设的 `imageGenerator` | 工具调用指定已启用的模板 |
| 尺寸、质量等参数 | 模型的 `image.defaults` | 模板参数绑定、`comfy.aspectRatios` |
| 生命周期 | 请求内等待，支持取消及超时 | 持久化异步任务、完成后触发会话 |
| 工具 | `generate_image` | `generate_image_with_comfyui` |

工作流模板包含节点、参数绑定和结果策略，不把它伪装成 LLM Provider 或模型，也不把标准接口参数放进 ComfyUI 配置。两个工具集可在会话工具设置中独立启用、停用；关闭其中一个不会关闭另一个。系统还会按实例功能开关和必要配置过滤可用工具。

## 启用开关与界面入口

- 通用图片生成：配置 → 运行时配置 → LLM → 图像生成 → 启用，对应 `llm.imageGeneration.enabled`。
- ComfyUI：配置 → 运行时配置 → ComfyUI → 启用，对应 `comfy.enabled`；同一区域可编辑连接、模板目录、工作流绑定、宽高比和任务参数。
- 以上均支持全局默认和实例覆盖；要修改所有实例的默认值，选择“全局运行时配置”。恢复继承会移除实例覆盖。
- 会话工具设置中的“通用图片生成”“ComfyUI 图片生成”进一步控制该会话可调用哪一种工具；会话开关不会越过实例的功能禁用。保存运行时配置后热重载生效。

## 标准图像模型

在 `llm.catalog.yml` 的现有 OpenAI 兼容 Provider 内添加模型。`openai` 和 `openai_responses` 均支持标准 Images 端点；不会因聊天使用 Responses 而改用 `/responses` 生图。

```yaml
images_provider:
  type: openai
  baseUrl: https://api.openai.com/v1
  apiKey: replace-me
  models:
    image:
      upstreamModel: gpt-image-1
      image:
        defaults:
          size: 1024x1024
          quality: low
          output_format: png
```

`image.defaults` 仅用于 Images API，模型的对话 `chat.defaults` 不会混入生图请求。所有图像参数均可省略以使用上游默认值；工具的 `size` 可覆盖模型默认尺寸。只有明确要求的兼容服务才配置 `response_format: b64_json` 或 `url`，GPT Image 不支持该参数。

在 `llm.routing-presets.yml` 为所用预设指定目标（或在 `default` 中设置，由其他预设继承）：

```yaml
default:
  imageGenerator:
    - provider: images_provider
      model: image
```

模型身份继续使用 `{ provider, model }`。WebUI 路由选择器只列出 OpenAI 兼容 Provider 下的生图模型。与其他角色一致，未设置字段时继承 `default`，显式 `[]` 清空；一次请求只使用第一个有效生图目标，不自动故障重试或切换候选，避免超时后上游仍在生成导致重复计费。

全局或实例配置中启用：

```yaml
llm:
  enabled: true
  imageGeneration:
    enabled: true
    timeoutMs: 300000
chatFiles:
  enabled: true
```

调用 `POST <baseUrl>/images/generations`，固定 `n: 1`，接受标准 `data[].b64_json` 或 `data[].url`。URL 图片下载不会携带供应商密钥。响应、图片大小受资产上传限制约束；生成结果验证为 PNG、JPEG 或 WebP 后导入资产，返回 `asset_ref` 供现有发送工具使用。取消或失败时不导入结果，不自动发送消息。

协议参考：[OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)。

## 手动真实接口验证

默认测试不访问模型服务。配置完成后可运行 `npm run smoke:llm:image -- --instance acc1 --config-dir /path/to/config`；此命令会实际生成一张图片，只在临时目录导入资产并将样图复制至本地 `.superpowers/image-generation-smoke/`，不读写实例正式数据。

## OpenRouter

`type: openrouter` 使用 `/images`，从独立图像清单发现模型和参数范围。默认参数使用 `image.defaults.resolution`、`aspect_ratio`、`quality`、`output_format` 等；不发送标准 Images 的 `size`/`response_format`。已知枚举范围会在请求前校验。当前工具仅生成单张非流式图片，不提供参考图编辑；清单中的参考图/流式能力仅作为元信息保存。

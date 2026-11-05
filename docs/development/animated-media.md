# 动图视觉输入

动图与静态图片共用资产和视觉工具。`MediaVisionService` 先执行既有内容安全检查，再返回保留原始时序的动图。主对话、表情规划、图片描述、图片精读、表情库分析和视觉工具补充消息均经由 `LlmClient`，在实际供应商候选确定后选择输入形式。

## 能力声明

模型需同时声明图片输入能力和原生视频能力：

```yaml
chat:
  capabilities:
    supportsVision: true
    supportsVideoInput: true
```

WebUI 新增模型窗口和目录配置表单都可设置原生视频能力。模型清单明确提供 `architecture.input_modalities: [text, image, video]` 时可自动填入；不根据模型名字猜测能力，未知或显式关闭时使用拼图。只声明 `supportsVision` 不会自动启用视频。

| 供应商类型 | 原生视频内容 |
| --- | --- |
| `google`、`vertex`、`vertex_express` | `inlineData`，MIME 为 `video/mp4` |
| `dashscope` | 多模态端点的 `{ video: dataURL }` |
| `openrouter` | Chat Completions 的 `video_url` 内容块 |
| `openai_compatible` | `video_url` 内容块，需自行确认兼容服务和模型支持 |

OpenAI 官方、Responses 兼容协议、Anthropic、DeepSeek 和 LM Studio 的当前适配器未实现原生视频输入，仍使用抽帧拼图。能力表与运行时、配置 Schema、WebUI 共享。这里适配的是聊天动图输入，未增加普通视频上传或视频生成工具。

## 转码与降级

支持视频时，将 GIF、动态 WebP 或其他可识别的动图转为一轮无声 H.264 MP4，以 Base64 内联发送，无需公开素材地址。需要系统 `ffmpeg` 且提供 `libx264` 编码器；不经 shell 执行。转码输出暂存于仅本用户可读的系统临时目录，以生成含完整时长索引的 MP4；成功、失败、取消后均清理。保留帧时序，并为 Gemini / DashScope 按原动画最短帧间隔设置最多 10 FPS 的采样频率，减少短动图因默认低频采样丢失动作。透明部分仅在视觉分析用视频中被合成为不透明画面，原资产不变。

视频每帧受 `conversation.images.maxSerializedPixels` 及 512×512 像素预算限制；转码上限为 512 帧、120 秒、128M 原始累计像素、30 秒处理时间，输出不能超过资产上传限制或 20 MiB。超限、缺少 ffmpeg 或转码失败时使用抽帧拼图，不截断动画冒充完整视频；取消请求会终止转码并取消模型调用。

DashScope 另要求视频至少 2 秒且编码后小于 10 MB；本地输出上限收紧到 7 MiB，且至少有 4 帧再尝试原生视频。过短或帧数不足的动画直接用拼图，不补帧或循环拉长冒充原时长。

不支持视频的候选使用按动画长度选择的 3–5 帧拼图，实际采样不超过原始帧数，拼图总面积受序列化像素预算约束。请求保存原始动图内容，每个备用候选独立投影，避免先选择视频后把 MP4 发给图片模型，或先拼图后丢失原视频信息。视频预算按时长和采样频率预留本地估算 Token，不把 Base64 长度当成文本 Token；实际计费以供应商为准。

生成 GIF 的配置见 [图像生成](image-generation.md)。默认测试不调用真实模型；回归测试会验证各协议的请求体，并在 ffmpeg 可用时用真实转码和 ffprobe 核对两帧动画的尺寸、帧数与不等帧时长。

协议参考：[Gemini 视频](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding)、[OpenRouter 视频](https://openrouter.ai/docs/guides/overview/multimodal/videos)、[DashScope 多模态](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope)。

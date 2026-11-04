# 内容安全审核供应商

内容安全独立于对话模型路由，只有一个供应商选择：`contentSafety.provider`。所有 Profile、文本、图片、表情和工具媒体审核均使用该供应商；不再存在供应商别名列表、默认供应商或规则级供应商覆盖。

## 配置与选择

WebUI 配置编辑器在“内容安全”最外层直接选择“阿里云内容安全”或“OpenAI 内容安全”，内层 `config` 只展示对应参数。共同的 `enabled`、失败策略、审计、缓存、Profile 规则和路由在切换时保留；不适用的供应商参数被清除。

- `provider: aliyun`：`config` 包含 AccessKey、地域、Endpoint、`services`、`variants`、超时及代理。
- `provider: openai`：`config` 包含 API Key、API 根地址、审核模型、超时及代理。
- `provider: keyword` 和 `noop` 用于本地测试，分别使用关键词配置和空配置。

供应商启用状态统一由 `contentSafety.enabled` 控制。Profile 中只配置审核动作、风险等级和置信度阈值，不选择供应商。DashScope 请求头继续通过 `routes.llmProviderFallback.dashscope.useDataInspectionHeader` 独立控制。

OpenAI 示例：

```yaml
contentSafety:
  provider: openai
  enabled: true
  config:
    baseUrl: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY
    model: omni-moderation-latest
    timeoutMs: 6000
    proxy: false
  failPolicy: allow
  profiles:
    preLlm:
      text:
        action: replace_in_projection
      image:
        action: hide_from_projection_and_mark
      emoji:
        action: hide_from_projection_and_mark
  routes:
    prompt:
      preLlm: preLlm
    toolMedia:
      chatFile: preLlm
      localFile: preLlm
```

`config.apiKey` 优先于 `config.apiKeyEnv`。凭据独立于 LLM 目录，不隐式读取对话模型配置。`baseUrl` 包含 `/v1`，请求使用 `POST {baseUrl}/moderations`。`proxy` 控制是否使用公共代理配置。

实例覆盖同一供应商时，可以只覆盖部分 `config` 参数；实例改选另一家供应商时，专属 `config` 从空对象开始，避免继承另一家的凭据、服务名或超时配置。共同审核策略仍按通常的配置层合并规则继承。

旧的 `providers`、`defaultProvider` 和规则中的 `provider` 已删除，不提供运行时兼容或迁移；实际 YAML 应直接调整为上述结构。

## 输入与结果

依据 [OpenAI Moderation 指南](https://developers.openai.com/api/docs/guides/moderation) 和 [接口定义](https://developers.openai.com/api/reference/resources/moderations/methods/create)：

- 文本和音频转写文本按字符串提交；公开图片 URL 使用 `image_url`，本地图片检测实际格式后以 base64 data URL 提交，不上传临时 OSS 对象。
- 本地图片支持不超过 20 MB 的 PNG、JPEG、WEBP、静态 GIF。动图不截取首帧冒充完整审核；原始音频、视频和普通文件不属于 OpenAI Moderation 的原生输入。传入这些内容或无效图片时按 `failPolicy` 处理。
- 图片并不支持所有文本审核类别。上游对不支持的类别返回 0 分，不应理解为对该类别进行了完整图片审核。
- 上游 `flagged` 或类别标记命中映射为高风险，继续应用现有 Profile 的风险等级、动作及置信度阈值。类别得分从 0–1 统一换算为 0–100；未命中的类别分数仍可供自定义阈值使用。OpenAI 模型升级后，自定义分数阈值可能需要重新校准。

`action: allow` 不发起审核请求。审核调用失败或凭据缺失时，`failPolicy: allow` 放行，`mark` 屏蔽并生成不可用标记；用户取消则直接向上层传播取消，不将其当作正常放行结果。上游错误正文不会进入审核错误日志。

## 缓存与热重载

成功审核结果记录唯一供应商、专属参数、规则、标记与缓存设置的哈希指纹。缓存命中必须同时满足指纹一致和未过期。切换供应商、修改规则、模型或缓存设置会重新审核；失败放行不会作为正常放行结果复用。

请求开始前固定供应商配置、规则及指纹，避免配置热重载将旧策略的请求结果写成新策略的缓存。现存没有指纹的历史审计仍可查看，但不作为当前策略的审核缓存。工具媒体守卫也重新验证当前策略，避免使用其他供应商留下的旧阻断结果。

默认测试仅使用公开合成样例和模拟 HTTP 响应，不访问真实审核服务或正式会话数据。

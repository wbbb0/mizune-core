# 内容安全审核供应商

内容安全保持独立于对话模型路由。开启 `contentSafety.enabled` 后，通过 `defaultProvider` 选择已启用的审核供应商，规则的 `provider` 可以覆盖默认选择。若两者都未指定，使用第一个已启用的供应商；显式选择不存在或禁用的供应商不会自动换一家，而是按失败策略处理。

## 配置与选择

WebUI 配置编辑器的“内容安全”中：

1. 在“Provider 列表”新增供应商，并选择“阿里云内容安全”或“OpenAI 内容安全”。供应商类型采用判别联合，只展示对应字段；切换类型后清除不适用的字段。
2. 保存供应商配置后，在“默认审核供应商”下拉框中选择其别名。候选来自当前实例的全局与实例配置合并结果。
3. 各 Profile 的“审核供应商覆盖”留空即可跟随默认选择；文本、图片、表情等也可以单独指定不同供应商。

阿里云使用 `type: aliyun_content_moderation`，配置 AccessKey、地域、Endpoint、文本/图片服务和接口变体。已有的 `services`、`variants` 结构保持原样。本地关键词和直接放行类型用于调试；DashScope 请求头继续通过 `routes.llmProviderFallback.dashscope.useDataInspectionHeader` 控制，不作为独立审核供应商。

OpenAI 示例：

```yaml
contentSafety:
  enabled: true
  defaultProvider: openaiCm
  failPolicy: allow
  providers:
    openaiCm:
      type: openai_moderation
      enabled: true
      baseUrl: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY
      model: omni-moderation-latest
      timeoutMs: 6000
      proxy: false
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

`apiKey` 可以直接填写，并优先于 `apiKeyEnv`。凭据独立于 LLM 目录，不隐式使用某个对话模型的连接信息。`baseUrl` 是包含 `/v1` 的 API 根地址，请求使用 `POST {baseUrl}/moderations`。`proxy` 独立控制该审核供应商是否使用公共 `proxy` 配置。

## 输入与结果

依据 [OpenAI Moderation 指南](https://developers.openai.com/api/docs/guides/moderation) 和 [接口定义](https://developers.openai.com/api/reference/resources/moderations/methods/create)：

- 文本和音频转写文本按字符串提交；公开图片 URL 使用 `image_url`，本地图片检测实际格式后以 base64 data URL 提交，不上传临时 OSS 对象。
- 本地图片支持不超过 20 MB 的 PNG、JPEG、WEBP、静态 GIF。动图不截取首帧冒充完整审核；原始音频、视频和普通文件不属于 OpenAI Moderation 的原生输入。传入这些内容或无效图片时按 `failPolicy` 处理。
- 图片并不支持所有文本审核类别。上游对不支持的类别返回 0 分，不应理解为对该类别进行了完整图片审核。
- 上游 `flagged` 或类别标记命中映射为高风险，继续应用现有 Profile 的风险等级、动作及置信度阈值。类别得分从 0–1 统一换算为 0–100；未命中的类别分数仍可供自定义阈值使用。OpenAI 模型升级后，自定义分数阈值可能需要重新校准。

`action: allow` 不发起审核请求。审核调用失败或供应商缺失时，`failPolicy: allow` 放行，`mark` 屏蔽并生成不可用标记；用户取消则直接向上层传播取消，不将其当作正常放行结果。上游错误正文不会进入审核错误日志。

## 缓存与热重载

成功审核结果记录供应商、模型、规则、标记与缓存设置的哈希指纹。缓存命中必须同时满足指纹一致和未过期。切换默认供应商、修改规则、模型或缓存设置会重新审核；失败放行不会作为正常放行结果复用。

请求开始前固定供应商配置、规则及指纹，避免配置热重载将旧策略的请求结果写成新策略的缓存。现存没有指纹的历史审计仍可查看，但不作为当前策略的审核缓存。工具媒体守卫也重新验证当前策略，避免使用其他供应商留下的旧阻断结果。

默认测试仅使用公开合成样例和模拟 HTTP 响应，不访问真实审核服务或正式会话数据。

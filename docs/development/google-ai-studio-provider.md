# Google AI Studio 接入

`type: google` 使用锁定版本的 `@google/genai` Developer API。项目负责路由、会话、工具权限、超时和代理；SDK 负责请求转换与流解码。Vertex 和 Vertex Express 保留 REST 接入及各自鉴权，不使用 SDK 的 Vertex/ADC 模式。

## 配置与能力

供应商填写 API Key 和独立的 `proxy` 开关。Base URL 可省略；自定义地址可带 `/v1beta`、`/v1alpha` 或 `/v1`，也可只填服务根地址，代理路径前缀会保留。生成与模型清单使用同一端点解析。配置不从 Google SDK 的宿主环境变量继承路由或凭据。

模型按用途声明能力；未知能力保持未知。Google 支持聊天、既有音视频输入与原生 JSON 输出。`supportsStructuredOutput: true` 对应 `responseMimeType: application/json` 和 `responseJsonSchema`；工具使用 `parametersJsonSchema`，保留原始约束。工具执行仍需通过项目的协议和参数校验。

思考摘要开关与推理强度分开。`thinkingControllable` 仅表示可完全关闭推理；模型如何调整推理由显式 `chat.googleThinking` 控制，不根据模型名推断：

```yaml
chat:
  capabilities:
    supportsThinking: true
    thinkingControllable: true
    supportsStructuredOutput: true
  googleThinking:
    mode: budget
    budget: 2048
  defaults:
    maxOutputTokens: 8192
```

对于明确支持 level 的模型，使用 `googleThinking: { mode: level, level: HIGH }`（可选值 `MINIMAL`、`LOW`、`MEDIUM`、`HIGH`，必须选择该模型实际支持的值）。budget 模式下，只有声明可关闭思考且本次关闭时才发送预算 0。隐藏摘要不会将 level 偷换为 LOW。输出预算需要同时容纳推理和正文。

`defaults.extra` 仅允许当前适配器支持的少见生成字段：`stopSequences`、`seed`、`frequencyPenalty`、`responseLogprobs`、`logprobs`。其他字段明确报错。传输、存储、工具和系统指令不能通过 extra 覆盖。常用参数使用显式控件。

清单通过 SDK 分页获取，最多 50 页，整次请求受时限控制。SDK 的 `supportedActions` 在边界归一为内部生成方法；`thinking` 仅证明思考能力，不推断视觉、工具或关闭推理能力。Live 专用方法不会被当成 GenerateContent 聊天能力。清单缺少模态信息时不按模型名称猜用途；请核对模型文档再设置图像、音频等用途。Google 图像生成和向量调用尚未实现，模型目录登记不等于适配器可调用，能力测试会明确显示当前接入未支持。

## 历史与工具

原始 `googleParts` 独立于展示正文保存，保留边界、顺序、调用 ID 和签名。重复文本增量不会按内容全局去重；空文本承载的尾部签名不会被展示归一化删除。并行调用只要求首个调用带签名，不能把签名搬到其他 Part。

原始历史绑定供应商、模型和规范化端点。完整回复还绑定实际保存的消息片段；删除、压缩、修改任一来源片段后，完整原始响应不可重放。正常投影中，原始响应替代对应展示片段，避免重复前段。展示去重和格式化不会改写原始协议内容。

不能验证来源、签名或调用参数的工具历史转成带来源的普通历史观察，保留已执行结果，不构造伪签名或再次执行。显式调用 ID 用于配对；上游未提供 ID 时，项目生成唯一内部 ID，但回传时不冒充上游 ID。`toolCall`、`toolResponse` 和代码执行属于服务端工具事件，保留为协议历史，不交给本地工具调度。

文本聊天不接受生成媒体输出，以免把图片 base64 写入会话历史。原生搜索的 grounding 来源经共享引用校验、去重后展示；这是来源列表，不代表逐句引用定位。

## 生命周期与诊断

GenerateContent 固定 `store: false`，关闭 SDK 自动续接、自动函数执行和重试。超时只由项目控制器管理，不设置 SDK 的 `httpOptions.timeout`。任何有效候选 Part 结束首响应等待；思考和总时限仍独立有效。

必须收到正常 STOP 终态才提交成功；截断、阻断、未完成工具参数、流错误与未终止 SSE 事件均失败。取消或异常退出会中止所属请求并取消响应体；不会关闭共享代理 dispatcher。SDK HTTP 状态统一转为 `LlmProviderHttpError`，继续使用现有 fallback、能力探测和诊断 dump 规则。独立 Google Grounding 搜索继续使用 search 代理和超时，改用请求头传 Key 并固定 `store: false`。

默认回归测试不调用真实模型。真实验证使用 `GOOGLE_SMOKE_MODEL=google/模型别名 npm run smoke:llm:google`，必要时显式设置 `CONFIG_DIR` 和 `CONFIG_INSTANCE`。可用 `GOOGLE_SMOKE_THINKING_BUDGET=2048` 仅在 smoke 内指定预算控制。脚本仅传公开合成文本、工具及动画，不读取会话数据或保存 dump。

独立能力通过不等于任意组合都可用。真实 Gemini 2.5 Flash 会拒绝搜索与 JSON 输出、部分搜索与本地工具组合；错误保留上游 400 状态交给现有策略处理，不删除用户选择的能力来伪装成功。smoke 分别验证纯 JSON、本地工具和原生搜索；Gemini 3.8 Flash 与 Gemini 4 Argon 另已验证带搜索的 JSON／本地工具组合。

# OpenAI 官方供应商

## 类型与配置

- `openai`：官方接口，默认 `https://api.openai.com/v1`。
- `openai_compatible`：Chat Completions 兼容协议。
- `openai_responses_compatible`：Responses 兼容协议。

连接信息由供应商统一持有；各用途在模型下独立声明。供应商别名和模型别名共同组成路由目标，不根据模型名字猜测用途或能力。完整配置见 `config/llm.catalog.example.yml`，预设见 `config/llm.routing-presets.example.yml` 的 `openai_native`。类型改名直接编辑现有 YAML，不提供迁移逻辑或旧类型别名。

| 用途 | 原生接口 | 配置位置 |
| --- | --- | --- |
| 对话、看图、工具调用 | `/responses` | `chat`、主模型及辅助文本路由 |
| 联网搜索 | Responses `web_search` | `chat.capabilities.supportsSearch` 与 `chat.searchEnabled` |
| 向量 | `/embeddings` | `embedding`，通过 `context.embedding.model` 引用 |
| 音频转写 | `/audio/transcriptions` | `transcription`、`audioTranscription` 路由 |
| 语音生成 | `/audio/speech` | `speech`、`speechGenerator` 路由 |
| 图片生成与编辑 | `/images/generations`、`/images/edits` | `image`、`imageGenerator` 路由 |
| 条件概率、分类、评分 | `/decisions` | `decision`、同名路由 |

语音生成和决策工具分别由 `llm.speechGeneration.enabled`、`llm.decision.enabled` 开启，默认关闭。图片沿用 `llm.imageGeneration.enabled`。这些开关控制工具可见性，模型用途及路由控制实际目标。内部轮次规划在存在有效 `decision` 路由时优先使用它，不依赖 `make_decision` 工具是否可见；仍受 `llm.turnPlanner.enabled` 及本轮实际职责控制。

## Responses 与本地历史

官方与兼容 Responses 共用协议实现，官方类再组合原生音频和决策能力。请求、代理、认证、取消、超时和诊断继续使用项目公共设施。

本地会话是历史管理入口。请求固定 `store: false`，不允许 `extra` 引入 `previous_response_id`、`conversation` 或后台任务状态链。原生输出项保存在 assistant metadata 中；只有供应商别名、类型、模型及规范化端点全部一致时才回放，切换来源时重新使用普通消息与函数调用历史。

`reasoningEffort` 映射到 `reasoning.effort`，`verbosity` 映射到 `text.verbosity`。是否支持某个强度取决于上游模型；只有模型明确允许关闭思考时才声明 `thinkingControllable: true`。返回的推理摘要不等于完整内部推理。

## 搜索与结构化输出

原生搜索返回的引用和来源进入 metadata。普通文本对所有消息出口附上可读链接；Sessions 页另展示去重来源列表。结构化输出保留原始 JSON，来源只留在 metadata，避免污染解析结果。

`LlmClient.generate()` 的 `responseFormat` 支持 `json_object` 和 `json_schema`。聊天轮次规划器及结构化建议器在整条候选路由均声明 `chat.capabilities.supportsStructuredOutput: true` 且协议支持原生格式时使用该能力；混合路由使用现有文本契约，避免切换模型后无法满足协议。原生严格 JSON schema 中对象必须声明 `additionalProperties: false`，并完整列出必填属性。

## 转写、语音与资产

`LlmClient.transcribe()` 对官方模型上传音频文件；兼容供应商继续使用各自聊天音频输入协议。官方转写支持语言和转写提示，不接收聊天采样、搜索或工具参数。

`generate_speech` 通过 `LlmClient.synthesize()` 生成 `audio_generated` 资产，返回现有资产句柄，再由 `asset_send_to_chat` 发送。语音合成失败不自动换候选重试，避免重复计费。转写、决策只对既有策略允许的服务端或传输故障切换候选；调用方取消始终停止。

官方当前 Speech API 的 `gpt-4o-mini-tts` 等模型已宣布于 **2027-01-06** 退役；当前实现使用仍可用的 `/audio/speech`。后续迁往 Realtime 属于独立语音协议适配，不能只把其模型名填入 Speech API。参见 [官方语音文档](https://developers.openai.com/api/docs/guides/text-to-speech)。

图片参考图编辑、蒙版和资产校验见 [图像生成](image-generation.md)。图片和音频均不在失败后自动重复生成。

## Decisions 边界

`LlmClient.decide()` 支持 `predicate`、`choice`、`score`，返回有类型的结果或明确的拒绝项。`make_decision` 接受 `input` 文本、可选 `data` JSON 对象/对象数组，以及 `reference_images` 图片资产引用。JSON 限制为 256 KiB，图片只读取已登记静态资产，并复用媒体访问检查；不把参数中的本地路径或网络 URL 当作文件读取入口。它不生成任意对象或执行动作。内部轮次规划通过独立适配器将固定选项和候选判断映射为统一规划结果，再复用业务规则校验；不替代权限策略、摘要或状态写入。选路、超时和拒绝策略见 [轮次规划](../architecture/turn-planner.md)。

使用时按实际账号权限配置决策模型。问题名称、选项、等级和返回分布会在本地校验，缺失答案不能当作否定结果。协议见 [官方 Decisions 文档](https://developers.openai.com/api/docs/guides/decisions)。

## 验证与诊断

默认 `npm run test` 不调用真实模型。真实接口验证使用：

```bash
npm run smoke:llm:openai -- --instance acc1 --provider openai_official --capability responses
npm run smoke:llm:openai -- --instance acc1 --provider openai_official --capability all
```

`all` 会调用已配置的生成、搜索、向量、转写、语音、图片和决策模型并产生费用；缺少任何用途会在请求前报错。脚本使用临时数据目录及固定公开测试内容，不读取正式会话，不改现有配置，不自动重试生成请求。单独转写验证需通过 `--audio-file` 提供公开测试音频；全能力验证使用本次合成的 WAV 音频。

原生语音、转写和决策诊断分别使用 `audio-`、`transcription-`、`decision-` 文件前缀，和聊天、图片诊断隔离。二进制结果不序列化为解析后的 Buffer JSON。`skipDebugDump` 继续对内部调用生效。

官方接口参考：[Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[搜索](https://developers.openai.com/api/docs/guides/tools-web-search)、[向量](https://developers.openai.com/api/docs/guides/embeddings)、[转写](https://developers.openai.com/api/docs/guides/speech-to-text)、[图像](https://developers.openai.com/api/docs/guides/image-generation)。

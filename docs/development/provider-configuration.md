# 供应商配置表单与能力预设

## 用户操作

LLM 目录以供应商为一级目录。创建供应商后先选择类型，表单只显示该协议适用字段；
切换类型时保留连接信息与模型清单，移除新类型不使用的字段。

| 类型 | 搜索配置 | 其他专属选项 |
| --- | --- | --- |
| DeepSeek | 模型勾选“允许联网搜索”；工具定义自动生成 | 供应商搜索次数上限，默认 3 |
| Google / Vertex / Vertex Express | 模型勾选“允许联网搜索” | 内容拦截阈值 |
| DashScope | 模型勾选“允许联网搜索”；思考开关自动映射 | 无需填写 enable_search / enable_thinking |
| OpenAI Responses | 模型勾选“允许联网搜索”；默认使用 web_search | 兼容接口高级覆盖 |
| OpenAI Chat Completions 兼容接口 | 没有统一原生搜索协议，需按服务商说明配置高级覆盖 | 自定义请求字段或工具定义 |
| LM Studio / Anthropic | 当前不展示联网搜索开关 | LM Studio 可覆盖思考请求字段 |

“允许联网搜索”默认关闭，只有模型实际支持时才启用。供应商能力预设不会替用户判断模型能力。
上游模型名和 API key 仍需填写；标准供应商通常不需要填写 Base URL，自建或转发接口应填写其地址。

## 结构边界

- `llmProviderDefinitions.ts` 维护供应商类型、展示名和适用能力目录。
- 持久化 `llmCatalogFileSchema` 按 `type` 构建 discriminated union；同一 Schema 同时负责解析、校验和 UI 元数据。
- `normalizeLlmCatalog` 在加载边界补齐统一运行时结构，继续使用 provider/model 联合引用。
- `providerFeatures.ts` 在模型能力许可范围内生成协议默认工具或请求字段。
- `features` 只作为兼容接口的高级覆盖入口；已知协议不再要求用户手填内部工具类型、名称和字段路径。
- 通用对象分支投影放在 workbench-kit：元数据里的 `discriminator` 启用此行为，普通 union 的行为保持不变。
- provider/model 的别名、重命名/删除对路由的协调、revision 检查仍由已有目录事务处理。

## 配置更新

正式目录结构以 `config/llm.catalog.example.yml` 为准。已知协议下旧的手工 `features` 字段已不再使用；
DeepSeek 搜索参数改为 `search.maxUses`，是否允许搜索仍由模型 `supportsSearch` 控制。
非 Google 供应商不再持久化 `harmBlockThreshold`。加载会按当前 Schema 去掉不适用字段，
不保留旧能力映射的双读逻辑。更新正式配置前应单独备份并校验；开发 worktree 不自动改写运行实例配置。

协议参考：[DeepSeek](https://api-docs.deepseek.com/guides/anthropic_api/)、
[Google 搜索](https://ai.google.dev/gemini-api/docs/google-search)、
[DashScope 搜索](https://help.aliyun.com/zh/model-studio/web-search)。

## 生成参数与连接设置

模型的 `apiParameters` 按供应商生成参数表单，数值都有基础校验：概率范围、非负随机程度、整数输出上限等。
具体模型可能不支持某些协议级参数，不确定时留空使用上游默认值。

- Google 系列不显示 `min_p`、`repetition_penalty`；Anthropic 不显示 presence/repetition penalty。
- Responses 和 DeepSeek 只显示当前适配器支持的 temperature / top_p 采样项。
- LM Studio 保留本地模型常用的 top_k、min_p 和重复惩罚。
- `maxOutputTokens` 是统一输出上限字段，适配器负责转换为 `max_tokens`、`max_output_tokens` 或 `generationConfig.maxOutputTokens`。
  OpenAI 兼容接口还可通过供应商的 `maxOutputTokenField` 下拉框选择 `max_completion_tokens`。
- `extra` 作为高级透传入口保留；显式参数覆盖对应的同名透传参数。常规输出上限不再需要手写 JSON。

Vertex 可填写 `projectId` 和 `location`（默认 `global`），由适配器生成地址。
`baseUrl` 是可选的完整覆盖；保存 Vertex 配置至少需要项目 ID 或自定义地址。
`apiKey` 在 Vertex 表单中显示为“访问令牌”，仍是已有的静态 Bearer 认证，不自动获取或刷新令牌。

例子：

```yaml
vertex:
  type: vertex
  projectId: my-google-cloud-project
  location: global
  apiKey: replace-with-access-token
  models:
    flash:
      upstreamModel: gemini-2.5-flash
      supportsSearch: true
      apiParameters:
        temperature: 0.7
        maxOutputTokens: 4096
```

参考：[Vertex 地址](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations)、
[Gemini 生成参数](https://ai.google.dev/api/generate-content)、
[LM Studio 请求参数](https://lmstudio.ai/docs/developer/rest/chat)。

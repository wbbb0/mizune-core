# 供应商配置表单与能力预设

## 用户操作

LLM 目录以供应商为一级目录。创建供应商后先选择类型，表单只显示该协议适用字段；
切换类型时保留连接信息与模型清单，移除新类型不使用的字段。

| 类型 | 搜索配置 | 其他专属选项 |
| --- | --- | --- |
| DeepSeek | 模型勾选“允许联网搜索”；工具定义自动生成 | 供应商搜索次数上限，默认 3 |
| Google / Vertex / Vertex Express | 模型勾选“允许联网搜索” | 内容拦截阈值 |
| DashScope | 模型勾选“允许联网搜索”；思考开关自动映射 | 无需填写 enable_search / enable_thinking |
| OpenAI 官方 | Responses 原生搜索，来源随消息展示 | 原生转写、语音、图像编辑、Decisions；各模型独立配置用途 |
| OpenAI Responses 兼容 | 模型勾选“允许联网搜索”；默认使用 web_search | 兼容接口高级覆盖 |
| OpenAI Chat Completions 兼容接口 | 没有统一原生搜索协议，需按服务商说明配置高级覆盖 | 自定义请求字段或工具定义 |
| LM Studio / Anthropic | 当前不展示联网搜索开关 | LM Studio 可覆盖思考请求字段 |

“允许联网搜索”默认关闭，只有模型实际支持时才启用。供应商能力预设不会替用户判断模型能力。
上游模型名和 API key 仍需填写；标准供应商通常不需要填写 Base URL，自建或转发接口应填写其地址。

### 新增模型：从清单选择或手动填写

在 provider 的 `models` 目录点“添加”时，弹窗而非直接插入空行，避免手动拆模型 id 的格式：

- **从供应商清单选择**：打开窗口后自动调用后端 `POST /api/editors/llm_catalog/list-models`，携带当前 provider 草稿连接信息，
  从模型清单接口拉取模型 id；窗口支持按模型名或别名搜索、区分可添加与已配置模型，并可手动刷新。支持 OpenAI 兼容协议
  （`openai` / `openai_compatible` / `openai_responses_compatible` / `deepseek` / `dashscope` / `lmstudio` 走 `{baseUrl}/models`，
  DashScope 默认重写到 `compatible-mode/v1`）与 Anthropic（`{baseUrl}/v1/models`）；Google AI Studio 使用 SDK 模型清单与有界分页；Vertex 暂不自动拉取，会给出提示。原生清单缺失的信息由 provider 基类通过 models.dev 补齐；自定义网关可用 `modelsDevProvider` 显式选择元信息供应商，匹配规则与缓存策略见 [模型目录与向量配置](model-catalog.md)。
- **手动填写**：直接输入上游模型名。
- 两种方式都会自动生成 `[a-z0-9_]` 格式的局部模型别名（新模型可改，重复时追加 `_2`、`_3`），允许选择一个或多个用途。模型信息表单直接使用后端目录 Schema 的对应供应商分支生成，覆盖显示名、能力、限制、请求默认参数、思考/搜索设置、向量处理参数、图像参数以及原生转写/语音设置；无需另外维护一份字段表；没有固定字段的开放对象（如 `extra`）统一使用 JSON 输入。
- 若模型已存在于当前 provider（按上游模型名匹配），窗口会锁定并沿用原别名，提交时更新其设置而保留原 alias 与未改动的参数；
  新模型若手动输入了其他模型正在使用的别名，会阻止提交，避免静默覆盖目录项。
- 窗口使用 workbench-kit 的容器响应式分栏：宽窗口并排显示来源与配置，拖窄后改为“模型来源 / 模型信息”两个 Tab；模型清单会填充可用高度并独立滚动。点击清单项通过 `activePaneId` 切换到模型信息；初次自动选择不跳转。切换 Tab 保留选择与配置草稿。
- 点击“添加模型 / 更新模型”后先弹出确认窗口，确认后通过目录统一校验再写入当前草稿。新增窗口保持打开，窄屏返回来源页签，清单状态和别名占用随草稿实时更新，允许连续添加；手动模式成功后清空输入。取消确认或校验失败保留输入。点击“完成”关闭窗口，之后仍需保存目录才会写入配置文件。确认和校验期间若窗口关闭、目录切换/重载、供应商类型变化或草稿发生并发修改，会停止写入。

该流程复用了 workbench-kit `vue-resource-editor` 的 record 变更拦截钩子：`beforeRecordMutation` 事件扩展了
`kind: "add"`（含 record 节点 `path`），返回 `false` 时可取消默认的空白新增，转由业务层弹窗写入。
拉取、别名生成与能力裁剪的纯函数位于 `src/llm/provider/modelListDiscovery.ts`，可独立单测。

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
DeepSeek 搜索参数改为 `search.maxUses`，是否允许搜索仍由模型 `chat.capabilities.supportsSearch` 与 `chat.searchEnabled` 控制。
非 Google 供应商不再持久化 `harmBlockThreshold`。加载会按当前 Schema 去掉不适用字段，
不保留旧能力映射的双读逻辑。更新正式配置前应单独备份并校验；开发 worktree 不自动改写运行实例配置。

协议参考：[DeepSeek](https://api-docs.deepseek.com/guides/anthropic_api/)、
[Google 搜索](https://ai.google.dev/gemini-api/docs/google-search)、
[DashScope 搜索](https://help.aliyun.com/zh/model-studio/web-search)。

## 生成参数与连接设置

模型各用途的 `defaults`（例如 `chat.defaults`）按供应商生成参数表单，数值都有基础校验：概率范围、非负随机程度、整数输出上限等。
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
      chat:
        capabilities:
          supportsSearch: true
        searchEnabled: true
        defaults:
          temperature: 0.7
          maxOutputTokens: 4096
```

参考：[Vertex 地址](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations)、
[Gemini 生成参数](https://ai.google.dev/api/generate-content)、
[LM Studio 请求参数](https://lmstudio.ai/docs/developer/rest/chat)。

## Routing preset 的模型目标选择

路由目标始终是 `{ provider, model }` 复合引用。分组选择器属于 workbench-kit 的通用动态选项组件：切换 Provider 后若没有同名有效模型，只保留本地选择草稿；选定模型时才一次替换完整引用，不向配置写入空数组项或半个目标。

删除模型后，已有路由引用仍保留并提示失效，避免静默改变路由顺序或继承语义；可直接重新选择 Provider 和模型修复。保存、加载或重新加载配置会刷新动态选项目录，组件库统一处理请求复用和过期响应丢弃。供应商及模型目录的业务定义继续由本项目 `/api/editor-options` 提供，组件库不识别 Provider 或模型字段。

路由角色的默认值由后端 `createRoutingPresetEditorFeatures` 从当前路由定义生成，通过通用 `record_inheritance` 契约传给编辑器。组件库不再硬编码角色列表，新增 `imageGenerator` 等字段可自动参与继承与回显。

## OpenAI 类型与能力边界

`openai` 专用于官方接口；兼容 Chat Completions 使用 `openai_compatible`，兼容 Responses 使用 `openai_responses_compatible`。本次类型调整直接更新现有 YAML，不提供自动迁移、旧类型别名或双读逻辑。

官方供应商的 `transcription` 使用原生 Audio 转写参数；`speech` 和 `decision` 仅在官方类型提供。图像字段按供应商协议裁剪：官方不展示 `response_format`，OpenRouter 使用比例与分辨率，兼容 Images 可选择响应格式。官方向量输入固定为原文，避免发送兼容服务专属的 `input_type`。

`speechGenerator` 和 `decision` 路由与其他角色共用持久化、默认继承、动态选项和引用事务。详见 [OpenAI 官方供应商](openai-provider.md)。

## 模型能力与连通性测试

在 LLM 模型目录中，每个模型项提供“测试能力”按钮。窗口使用当前草稿中的连接信息和上游模型名，不要求先保存，也不要求提前声明被测试用途。

默认选择对话和向量。可按需选择转写、原生决策、语音和图像；媒体生成默认不选择，运行前明确说明会真实生成并计费。每项测试只执行一次，不调用会话工具，不使用模型候选 fallback，不自动保存能力标记。结果仅说明本次简单请求是否成功，不代表视觉、工具调用或其它参数也已验证。

- “通过”：收到符合对应用途格式的响应。
- “当前接入未支持”：本项目该供应商适配器尚未实现该用途，不能据此断言上游模型不支持。
- “未确认”：鉴权、限流、网络、超时、参数或响应格式等原因使本次测试无法确认能力。

`POST /api/editors/llm_catalog/test-model` 受现有管理接口认证保护；每实例只允许一个正在执行的测试。窗口按顺序调用单项测试，停止或关闭窗口会取消剩余任务并通知后端取消当前请求。服务端使用内存中的隔离配置和固定公开测试内容，不读取聊天数据，不创建会话、资产或诊断 dump；返回值不包含凭据或上游完整错误正文。

编辑器按钮通过 workbench-kit 的通用 `nodeActions` 注入，组件库只处理节点路径、动作和展示，不包含供应商或模型业务逻辑。

Google AI Studio 的思考控制、JSON 输出、原始历史与调用边界见 [Google AI Studio 接入](google-ai-studio-provider.md)。

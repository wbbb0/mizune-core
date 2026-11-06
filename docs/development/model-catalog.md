# 模型目录与向量配置

## 职责与用途

`llm.catalog.yml` 管理供应商连接、模型身份以及模型各用途的能力、限制和默认参数。一个模型可以同时具有 `chat`、`embedding`、`image`、`transcription` 子树；存在子树表示配置了该用途。没有子树就不能作为该用途的路由目标。

`capabilities` 是已知能力声明，布尔值缺失表示未知，不等于不支持。能力声明不自动启用搜索或思考；聊天搜索还需要 `chat.searchEnabled`，思考仍由调用场景控制。`limits` 保存已知 token 上限，`defaults` 保存请求参数。转写目前使用聊天音频协议，不是 `/audio/transcriptions`。

```yaml
openrouter:
  type: openrouter
  apiKey: replace-me
  models:
    embedding:
      upstreamModel: qwen/qwen3-embedding-8b
      embedding:
        inputMode: qwen3
        queryInstruction: 根据查询检索相关的资料和记忆。
    chat:
      upstreamModel: vendor/chat-model
      chat:
        capabilities:
          supportsTools: true
        limits:
          contextTokens: 32768
          maxOutputTokens: 4096
        defaults:
          temperature: 0.7
```

`openrouter` 独立管理模型发现及 Images 协议，共用 OpenAI 兼容的聊天和向量传输。聊天模型可通过 `chat.defaults.extra.provider` 配置 OpenRouter 下游供应商选择；可选固定端点示例和成本比较见 [OpenRouter 轻量任务选型](openrouter-cost-selection.md)。

## 模型发现

新增窗口默认最大化，窄屏保留来源/模型信息页签，点击清单模型后切换到信息页。可以从清单选择，也可以手动填写 ID；同一模型可勾选多个用途。未知用途必须手选，按用途筛选时仍显示未知项。信息表单复用目录的供应商模型 Schema，所选用途的全部字段都可编辑。添加/更新先确认并统一校验，再写入当前目录草稿；窗口保持打开以继续添加，完成后仍需保存目录。

通用 `/models` 不保证返回用途、上下文上限或能力。程序只解释已知结构，不根据名称推断。OpenRouter 使用聊天、向量、图像三份清单，部分失败仍保留其他结果。Anthropic、Google 和 LM Studio 解析其文档化字段及分页/加载信息。

所有 provider 继承 `LlmProviderBase`，由基类统一完成“原生发现 → models.dev 元信息补齐”；有原生发现能力的接入可重写 `discoverNativeModels`，OpenRouter 的三份清单在其 provider 内声明。`modelListDiscovery.ts` 负责合并同 ID 的发现结果、生成别名并保留已有配置。

通用兜底读取 [models.dev API](https://models.dev/api.json?type=all)，按供应商内的完整上游模型 ID 匹配，不裁剪后缀、不跨供应商借用同名模型，也不增加原生清单没有返回的模型。专用接入可通过协议类型识别供应商，兼容网关按完整接口地址精确匹配；不能识别或存在歧义时不自动套用元信息。可在供应商层显式填写 `modelsDevProvider`，例如：

```yaml
relay:
  type: openai_compatible
  baseUrl: https://relay.example/v1
  modelsDevProvider: openai
  models: {}
```

目录补齐显示名、聊天/向量/决策用途、输入模态、工具/推理/结构化输出能力和 token 上限。原生清单已经声明用途时，仅补该用途的缺失字段；显式能力值和原生限制始终优先。思考支持不等于可关闭，只有明确的 toggle 或 off/none 选项才补可关闭能力。不会根据能力自动开启搜索或思考，也不会填请求默认参数。原生语音、转写及 Images 类型只在已实现对应原生接口的 OpenAI 官方接入中自动分类；其他接入仍需原生清单证明其调用协议。Realtime、视频生成等未支持用途不会被当作聊天。

公共目录在实例的 `dataDir/cache/models-dev/` 中持久化，按代理路径摘要区分缓存文件，文件不包含代理地址或凭据；进程内同时复用缓存与在途请求。缓存自获取成功起 1 小时失效，读取不延长有效期，服务重启后仍可复用。更新通过临时文件与原子重命名写入，损坏缓存会重新拉取，写盘失败不影响本次成功结果。请求 5 秒超时，失败后冷却 1 分钟；刷新失败可使用过期缓存并显示警告，无缓存时保留原生结果。整体清单操作的超时和取消仍有效：原生清单成功后，只有元信息等待耗尽预算时会返回原生结果并提示；调用方明确取消仍会终止操作。单个调用取消不会中止其他调用共享的目录请求。目录请求复用供应商代理设置，不发送 API Key、模型清单或业务数据；不会在启动或模型生成时请求目录。Vertex 仍不自动拉取原生清单。

发现结果只填缺失字段，优先级为已有配置、原生清单、models.dev，保留手动值、显式 false、默认参数和数组。窗口显示来源，冲突字段可逐项应用清单建议。刷新清单不覆盖当前编辑草稿。图像输出能力不自动等同于支持独立 Images API。

## 向量目标与处理

向量目标独立于聊天路由预设，位于全局/实例运行时配置：

```yaml
context:
  embedding:
    model: { provider: openrouter, model: embedding }
```

模型引用是原子值：实例覆盖必须完整指定 provider/model。`model: null` 显式禁用并阻断继承；移除覆盖则重新继承全局设置。供应商改名/删除同时处理路由及各实例向量引用，删除引用写入 null，防止意外切换到全局模型。

兼容接口输入处理有三种：`plain` 原文，`qwen3` 仅给查询添加 `Instruct: …\nQuery: …`，`input_type` 使用接口的 search_query/search_document 参数。文档向量与查询向量使用相同空间标识，空间覆盖供应商协议/地址、上游模型、实际维度、处理设置与分块版本。模型或处理方式改变后，旧向量不会混入新空间；记忆正文保留，后续检索或维护逐批补齐。

`dimensions` 是可选请求参数，只有接口支持时才设置。响应必须具有完整且唯一的索引、正确数量、统一非空维度和有限数值；文档检索拒绝不同空间或维度间计算相似度。

上下文数据页区分配置可用与最近请求健康状态，可主动使用合成文本测试，不读取聊天内容。补齐索引显示本批写入、覆盖/总量、剩余数量及失败原因；每次只处理配置的批量，不暗示一次完成全部重建。

## 请求预算

实际调用每个候选前，基于消息、工具和模型限制估算输入预算，限制输出参数；小上下文候选失败后会单独检查备用模型。不会为通过限制而静默删除历史或拆散工具调用配对。主会话压缩阈值受主模型输入预算约束。token 估算不等于上游 tokenizer 的精确计数，上游仍可能拒绝边界请求。

## 结构更新

不保留旧字段兼容分支。已有目录需要将 `modelType` 改为对应用途子树；扁平 `supports*` 放入聊天/转写的 `capabilities`，`preserveThinking` 放入该用途，`apiParameters` 改为 `defaults`，`imageParameters` 改为 `image.defaults`。原路由中的 `embedding` 移至每个实例的 `context.embedding.model`；如果原来有多个候选，明确选定一个空间目标。能力 `supportsSearch` 与开关 `searchEnabled` 分开设置。参照当前 example 配置更新后再部署。

Google 的 `task_type` / `task_prefix` 文本向量模式与原生图像参数见 [Google AI Studio 接入](google-ai-studio-provider.md)。任务前缀与归一化版本也参与向量空间身份，不根据上游模型名称选择输入模式。

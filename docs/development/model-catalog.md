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

新增窗口默认最大化，窄屏保留来源/配置页签。可以从清单选择，也可以手动填写 ID；同一模型可勾选多个用途。未知用途必须手选，按用途筛选时仍显示未知项。

通用 `/models` 不保证返回用途、上下文上限或能力。程序只解释已知结构，不根据名称推断。OpenRouter 使用聊天、向量、图像三份清单，部分失败仍保留其他结果。Anthropic、Google 和 LM Studio 解析其文档化字段及分页/加载信息。

发现结果只填缺失字段，保留手动值、显式 false、默认参数和数组。窗口显示来源，冲突字段可逐项应用清单建议。刷新清单不覆盖当前编辑草稿。图像输出能力不自动等同于支持独立 Images API。

## 向量目标与处理

向量目标独立于聊天路由预设，位于全局/实例运行时配置：

```yaml
context:
  embedding:
    model: { provider: openrouter, model: embedding }
```

模型引用是原子值：实例覆盖必须完整指定 provider/model。`model: null` 显式禁用并阻断继承；移除覆盖则重新继承全局设置。供应商改名/删除同时处理路由及各实例向量引用，删除引用写入 null，防止意外切换到全局模型。

输入处理有三种：`plain` 原文，`qwen3` 仅给查询添加 `Instruct: …\nQuery: …`，`input_type` 使用接口的 search_query/search_document 参数。文档向量与查询向量使用相同空间标识，空间覆盖供应商协议/地址、上游模型、实际维度、处理设置与分块版本。模型或处理方式改变后，旧向量不会混入新空间；记忆正文保留，后续检索或维护逐批补齐。

`dimensions` 是可选请求参数，只有接口支持时才设置。响应必须具有完整且唯一的索引、正确数量、统一非空维度和有限数值；文档检索拒绝不同空间或维度间计算相似度。

上下文数据页区分配置可用与最近请求健康状态，可主动使用合成文本测试，不读取聊天内容。补齐索引显示本批写入、覆盖/总量、剩余数量及失败原因；每次只处理配置的批量，不暗示一次完成全部重建。

## 请求预算

实际调用每个候选前，基于消息、工具和模型限制估算输入预算，限制输出参数；小上下文候选失败后会单独检查备用模型。不会为通过限制而静默删除历史或拆散工具调用配对。主会话压缩阈值受主模型输入预算约束。token 估算不等于上游 tokenizer 的精确计数，上游仍可能拒绝边界请求。

## 结构更新

不保留旧字段兼容分支。已有目录需要将 `modelType` 改为对应用途子树；扁平 `supports*` 放入聊天/转写的 `capabilities`，`preserveThinking` 放入该用途，`apiParameters` 改为 `defaults`，`imageParameters` 改为 `image.defaults`。原路由中的 `embedding` 移至每个实例的 `context.embedding.model`；如果原来有多个候选，明确选定一个空间目标。能力 `supportsSearch` 与开关 `searchEnabled` 分开设置。参照当前 example 配置更新后再部署。

# OpenRouter 轻量任务的模型与成本选择

跨会话最新消息读取应使用本地消息窗口，不增加后台模型调用。只有确实需要语义判断时才使用已有 turn planner；不要为了共享群消息额外部署持续总结或逐消息分类模型。

## 先控制请求，再选择模型

- 跨会话读取限制来源数量和总输入预算；未触发生成时不增加该功能的模型调用。
- Planner 使用 `llm.turnPlanner.enableThinking: false`。对于能力标记明确支持关闭思考、且整个候选链都满足条件的 OpenRouter 模型，请求发送 `reasoning.enabled: false`，同时沿用现有 512 token 输出上限。
- 当前 planner 输出是按需出现的固定字段，理由要求不超过 12 个汉字；该额度用于这些简短决策，不应套用到聊天、摘要或工具执行。增加输出字段或大量工具集时应重新评估预算。
- `thinkingControllable` 必须反映真实模型能力。GPT-OSS 等需要推理的模型不能为了套用短预算而标记为可关闭思考。隐藏思考内容不等于不产生推理费用。
- `preserveThinking: false` 控制历史思考的保留，不是关闭本轮思考的替代设置。
- 总成本应包含输入、缓存输入、输出及推理、失败回退和重试；比较每次成功决策的账单及延迟，而不仅是输出单价。

## 供应商报价快照

以下为 **2026-10-19** 查询 OpenRouter 官方 endpoints API 的美元价格，单位均为每百万 tokens；使用标准实时端点，未使用 flex、priority 或 batch 报价。价格会变化，不是长期承诺，也没有执行付费真实模型评测。

| 模型 | 实际供应商 | 输入 | 输出 | 缓存读取 | 选型判断 |
| --- | --- | ---: | ---: | ---: | --- |
| Ling 3.0 Flash | DeepInfra | 0.060 | 0.180 | 0.012 | 保守基线；无需因参数量较大而替换 |
| Ling 3.0 Flash | Novita | 0.021 | 0.063 | 0.0042 | 同模型，目前有 65% 折扣；先验证服务质量与延迟 |
| GPT-OSS 20B | DeepInfra | 0.030 | 0.140 | 未列出 | 可作低价候选，但有推理开销，不能视为无损替换 |
| Mistral Small 24B 2501 | DeepInfra | 0.050 | 0.080 | 未列出 | 非思考候选；中文规划质量尚未验证 |
| Gemma 3 12B | DeepInfra | 0.050 | 0.150 | 未列出 | 节省有限，质量尚未验证 |
| Llama 3.1 8B | DeepInfra | 0.020 | 0.040 | 未列出 | 单价低，不能据此保证中文语义与指令理解不下降 |
| Qwen3 Next 80B A3B Instruct | DeepInfra | 0.090 | 1.100 | 未列出 | 当前比 Ling 贵，不是省钱选择 |
| DeepSeek V4.1 Flash | DeepInfra | 0.140 | 0.420 | 0.0042 | 冷输入更贵，缓存命中高时需另算；当前价包含促销 |

来源：[Ling](https://openrouter.ai/api/v1/models/inclusionai/ling-3.0-flash/endpoints)、[GPT-OSS](https://openrouter.ai/api/v1/models/openai/gpt-oss-20b/endpoints)、[Mistral](https://openrouter.ai/api/v1/models/mistralai/mistral-small-24b-instruct-2501/endpoints)、[Gemma](https://openrouter.ai/api/v1/models/google/gemma-3-12b-it/endpoints)、[Llama](https://openrouter.ai/api/v1/models/meta-llama/llama-3.1-8b-instruct/endpoints)、[Qwen Next](https://openrouter.ai/api/v1/models/qwen/qwen3-next-80b-a3b-instruct/endpoints)、[DeepSeek](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)。

例如每次 2,000 个未缓存输入 tokens、200 个输出 tokens，一万次 Ling DeepInfra 约为 $1.56；GPT-OSS 按相同 token 数约 $0.88，但额外推理会增加实际费用。若 Ling 输入有 80% 缓存命中，该例约 $0.792，已经低于无缓存且尚未计算额外推理的 GPT-OSS 示例。该算例仅解释费用结构，不代表实测任务用量。

[OpenAI 官方 GPT-OSS 文档](https://developers.openai.com/api/docs/models/gpt-oss-20b)列出 low、medium、high 推理档位。不要将低推理档位当作无推理；OpenRouter 的具体服务行为还需按端点验证。

其他值得单独评测的候选是 [Qwen3.7 Flash](https://openrouter.ai/api/v1/models/qwen/qwen3.7-flash/endpoints)（Alibaba，短输入档 0.030/0.130，32K 起有更高价格档）及 [Nex N2.5 Mini](https://openrouter.ai/api/v1/models/nex-agi/nex-n2.5-mini/endpoints)（Nex AGI，0.025/0.100）。二者不是 DeepInfra 服务。当前 [Qwen3 30B A3B Instruct 2507](https://openrouter.ai/api/v1/models/qwen/qwen3-30b-a3b-instruct-2507/endpoints) 没有 DeepInfra 端点。

## 固定路由与默认选择

`config/llm.catalog.example.yml` 的 `openrouter/ling_flash_deepinfra` 展示了固定端点的可选模型条目。它不会自动接管任何模型角色。需要使用时，将现有预设的 `turnPlanner` 指向该 `{ provider, model }`；其他角色保持各自配置。不要给所有辅助任务统一设置 planner 的 512 token 限额。

模型 `chat.defaults.extra.provider` 可控制 OpenRouter 内部供应商路由：

```yaml
provider:
  only: [deepinfra/bf16]
  allow_fallbacks: false
  require_parameters: true
```

`only` 限定端点；仅设置 `order` 并不保证没有其他供应商回退。固定供应商会降低故障时的可用性，应按需要选择。若允许 Novita 和 DeepInfra，可改为 `only: [novita, deepinfra/bf16]` 并设置 `sort: price`；后续报价仍需核实。[OpenRouter 供应商路由说明](https://openrouter.ai/docs/guides/routing/provider-selection)。

目前默认建议保留 Ling，先消除不必要调用与超长输入。可以评测同模型低价供应商；没有中文 planner 对照结果前，不自动把所有辅助角色降为旧小模型。会话标题生成比回复门控、任务切换与工具选择更适合作为低成本候选的第一项试验。

评测应使用合成中文案例，包含半句话等待、明确拒答、引用其他会话、话题切换、任务暂停/恢复和工具续接。记录格式成功率、各决策正确率、P50/P95 延迟、推理 token、缓存命中及每次成功成本。默认单元测试使用 mock；真实模型测试必须显式启用。

# 轮次规划与成本控制

轮次规划在主模型生成前完成必要的语义判断。它不必每轮调用，也不承担全部历史压缩职责。

## 默认配置

```yaml
llm:
  turnPlanner:
    enabled: true
    toolSelection: all
    semanticWait: false
    maxWaitPasses: 1
    topicCompressionMinTokens: 2000
    topicCompressionMinMessages: 6
    supplementToolsets: true
    recentMessageCount: 6
    enableThinking: false
    timeoutMs: 20000
```

这些设置可在 WebUI 配置编辑器中修改。实例配置可以覆盖公共配置。

`toolSelection: all` 提供当前权限、模式、会话工具集偏好、模型能力允许的全部工具；不会解开权限边界。工具顺序遵循固定目录顺序。此模式不执行工具集选择、自动激活或语义补充，也不暴露 `list_available_toolsets`、`request_toolset` 及其提示。空的工具集边界仍代表没有业务工具。

`toolSelection: planned` 使用 planner 选择初始工具集，再执行确定性自动激活与可选语义补充；主模型可以申请一次额外工具集。`supplementToolsets` 仅在该模式生效。

`semanticWait: false` 依赖现有 debounce 合并连续消息，不进行语义等待判断。开启后允许模型判断半句话是否尚未结束，并受 `maxWaitPasses` 限制；达到次数上限便不再请求等待判断。关闭会减少前置调用，但较长停顿可能让主模型提前回应。

## 本轮职责计算

`turnPlannerPolicy.ts` 集中计算职责；无职责时直接继续生成，不调用规划模型，也不为 planner 准备图片描述或表情输入。多项职责合并成一次请求。

| 职责 | 启用条件 |
| --- | --- |
| 模型选择 | 已配置完整模型候选且大小模型路由不等价 |
| 工具集选择 | `planned` 且有可选工具集 |
| 群聊回复判断 | 当前入口确实允许不回复；私聊、明确提及与结构化触发按现有强制回复规则处理 |
| 语义等待 | 开启且尚未达到等待上限 |
| 话题切换 | 历史压缩与 summarizer 可用，且待压缩历史满足两项门槛 |
| 任务意图 | 存在未结束的主任务或 parked task |

初始化模式、显式跳过回复门控的续执行、定时任务专用执行链及工具结果回流沿用确定性入口，不新增规划调用。尚有待处理语音的批次沿用直接回复入口。

普通私聊在等价模型、全量工具、无相关任务、历史较短的情况下无需调用 planner。群聊回复判断与任务暂停、取消、恢复等意图不会因全量工具而被关闭。

## 模型等价

比较有序候选链中的完整解析后模型配置：provider、实际 model ID、能力声明、API 参数均需一致；模型别名本身不参与比较。后备模型或顺序不同不视为等价。

等价时固定使用 `main_small` 路由，planner 不接收大小模型选择提示，也不输出大小模型选择字段；升级工具自动隐藏。相同 provider 与 model ID 但参数不同的配置仍可代表不同推理策略，因此保留选择能力。升级工具继续要求所有候选来自同一 provider、支持工具，并且当前位于小模型路由。

## 话题压缩门槛

从真实 transcript 压缩快照取待压缩消息与工具观察，保留本轮批次。使用现有 token 估算权重计算原始内容大小，按其中 50% 估算可回收 token，给新摘要预留另一半；这只是触发启发式，并非实际压缩率保证。

同时满足以下条件才请求话题判断：

- 待压缩原始消息数达到 `topicCompressionMinMessages`。
- 预计可回收 token 达到 `topicCompressionMinTokens`。

已有摘要不计入门槛；压缩会移除旧原始历史，因此需要重新积累足够的新内容才会再次判断。未达到门槛时即使模型额外输出 `new_topic` 也不触发压缩。硬性 token 阈值压缩仍由 `HistoryCompressor.maybeCompress` 独立处理。

## Prompt 与异常处理

使用按职责组合的固定模板，静态指令在前，任务、历史、媒体和本轮消息在后。只输出本轮需要的字段，理由要求不超过 12 个中文字。模型选择关闭而仍需回复判断时，使用 `reply / wait / no_reply` 中本轮允许的值；内部固定回复路由仍使用 `main_small`。

只有关闭思考、且整条候选链均为非思考模型或 provider 确实能关闭其思考时，才请求最多 512 个输出 token；通过各 provider 的输出上限字段传递，覆盖本次请求的模型配置上限。启用思考、不可关闭思考、原生 Gemini/Vertex 的思考模型，以及未声明思考控制映射的 OpenAI 兼容或 DashScope 思考模型，均保留模型原有输出额度。隐藏思考文本不等于关闭思考，不能让短输出上限挤占推理额度。格式探针没有完整模型能力上下文，也保留模型原有额度。超时或不可解析结果直接继续回复，不新增修复请求。解析器只接受当前逐行字段格式，不保留旧 JSON 或竖线分隔协议。未启用职责的输出不会改变执行行为。

## 成本观测与 WebUI

- `turn_planner_required` 记录本轮职责与压缩候选估计。
- `turn_planner_skipped` 记录跳过原因；跳过规划不等于跳过主模型回复。
- `turn_planner_decided` 记录调用原因、输入/输出/缓存 token、总耗时、媒体准备耗时、模型耗时及媒体数量。
- 失败调用记录在 `turn_planner_llm_failed`；未取得 usage 的 token 为未知，不伪记为零。

实际规划决策的 `gate_decision` 包含 `plannerReasons` 和 `plannerMetrics`，WebUI Sessions 详情显示调用原因、耗时和 token。未请求话题判断时不记录话题结果；无模型选择时普通回复显示为 `reply`。直接跳过 planner 的轮次不制造模型决策记录，可通过日志检查。

媒体准备耗时包含等待或生成描述；描述服务自身的模型 token 不包含在规划模型 usage 中，需要结合描述服务日志评估。

固定工具清单有利于前缀复用，但不能保证缓存命中；动态 system 内容、历史重写、压缩、模型切换和服务端缓存策略仍有影响。缓存也不会消除工具占用的上下文长度。比较 `all` 与 `planned` 时，应同时测量整个轮次的费用、首字延迟、工具补充往返和任务成功率；本实现不预设节省百分比。

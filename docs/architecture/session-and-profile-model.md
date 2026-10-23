# 会话、身份与资料模型

本文档整理当前仓库已经采纳并在主干代码中落地的运行时模型，重点覆盖会话标识、用户身份、标题语义、全局 profile、会话级 profile 与会话工作态之间的边界。

## 身份、外部账号与会话入口的边界

当前实现明确把三类概念拆开：

- 内部用户：项目内部稳定使用的用户标识，不直接等同于 QQ / OneBot 等外部账号
- 外部身份：平台侧账号，通过独立绑定关系映射到内部用户
- 会话入口：消息进入系统的 session，不再承担“用户主键”职责

当前代码中的关键约束：

- `owner` 表示稳定的内部用户，而不是某个平台账号
- 外部身份与内部用户通过 `UserIdentityStore` 做一对一绑定
- `session.id` 表示消息入口和会话实例，不应再被当作长期用户主键使用
- 会话主体通过 `participantRef` 表达，而不是通过历史遗留的 `participantLabel` / `participantUserId` 混合承担多种语义

相关实现入口：

- `src/identity/userIdentityStore.ts`
- `src/conversation/session/sessionIdentity.ts`
- `src/conversation/session/sessionTypes.ts`
- `test/identity/user-identity-features.test.tsx`

## 会话标题与展示语义

会话模型中与展示直接相关的核心字段如下：

- `participantRef`
  - 只表达当前会话主体，结构为 `{ kind: "user" | "group", id }`
- `title`
  - Web 会话可独立持有的标题
- `titleSource`
  - 标识标题来源，当前取值为 `default`、`auto`、`manual`

这三者的职责分工如下：

- Web 会话优先展示 `title`
- 非 Web 会话默认根据 `participantRef` 推导展示标签
- `manual` 表示用户手动锁定标题，后续自动命名不应覆盖
- `auto` 表示标题由 captioner 生成
- `default` 表示仍处在默认标题语义下，允许后续自动命名

会话标题语义已经从其他状态里拆开：

- 会话标题不再依赖旧的 `participantLabel`
- 场景状态不应再把会话标题当成 `scenario_host` 自身状态字段的一部分
- Session 信息面板、列表页、internal API 都使用统一字段输出标题与来源

相关实现入口：

- `src/conversation/session/sessionTitle.ts`
- `src/conversation/session/sessionManager.ts`
- `src/internalApi/application/basicAdminService.ts`
- `webui/src/stores/sessionDisplay.ts`
- `test/session/persistence.test.tsx`
- `test/webui/session-display.test.ts`

## Session Captioner

`sessionCaptioner` 是独立于历史压缩器的标题生成能力，专门负责为 Web 会话生成或刷新标题。

当前约定：

- 仅 Web 会话支持标题编辑与标题再生成
- 自动标题不会覆盖 `manual` 标题
- `titleSource` 用于区分默认、自动生成和手动设置三种状态
- 标题生成能力通过 `internalApi` 暴露给 WebUI，用于会话操作窗口中的“重新生成标题”等操作

相关实现入口：

- `src/app/generation/sessionCaptioner.ts`
- `src/config/configModel.ts`
- `src/internalApi/application/basicAdminService.ts`
- `test/generation/session-captioner.test.tsx`

## 历史压缩器

历史压缩器仍是所有会话模式共享的运行时服务，负责把较早聊天记录压缩到 `historySummary`。不同模式只通过 prompt 变体调整摘要目标，不拆出独立调度器或专用存储。

当前约定：

- 普通会话摘要偏向保留任务状态、用户偏好、工具线索和待履行承诺
- `scenario_host` 会话摘要偏向保留可继续主持的剧情记忆、未结算行动、伏笔、实体关系变化和规则边界
- Scenario 的结构化 state 仍由 `ScenarioHostStateStore` 保存；历史摘要不复制完整 state，只保留解释剧情连续性、玩家意图和待处理伏笔所需的信息

相关实现入口：

- `src/conversation/historyCompressor.ts`
- `src/llm/prompts/history-summary.prompt.ts`
- `test/conversation/history-compression-features.test.tsx`

## 会话输出偏好

会话通过 `pacingPreferences.toolLoopOutput` 控制工具循环文本的对外输出方式：

- `progressive`：按现有流式/分段链路逐步发送模型文本。
- `final_only`：整轮生成不注册文本增量输出，即使没有工具调用也会等待生成完成后一次发送最终回复；工具调用期间的模型文本不对外发送。

该偏好在每轮生成开始时读取，进行中的生成不会因设置变化而切换行为。两种模式共用同一套 transcript：工具轮的 `assistant_tool_call` 和 `tool_result` 仍完整持久化，供 provider 回放和后台检查；聊天时间线与 OneBot 只接收实际投递形成的 `assistant_message`。因此切换模式不需要迁移历史消息，也不会改变工具协议边界。

相关实现入口：

- `src/conversation/session/sessionPacing.ts`
- `src/app/generation/generationSessionOrchestrator.ts`
- `src/app/generation/generationExecutor.ts`
- `webui/src/components/sessions/SessionPacingControl.vue`
- `test/generation/generation-session-orchestrator.test.tsx`
- `test/generation/generation-typing-lifecycle.test.tsx`

## 会话模型路由偏好

会话通过 `modelRoutingPreferences.selfUpgradeEnabled` 控制轻量模型是否可以在当前任务明显超出自身能力时，请求把本轮后续生成切换到完整模型。默认值为 `true`，WebUI 会话“设置”页可关闭；每轮生成开始时快照该值，进行中的生成不受后续设置修改影响。

该能力保持以下边界：

- 仅当当前路由严格等于 `mainSmall`，且 `mainSmall`、`mainLarge` 的全部候选模型都存在、支持工具并引用同一个 provider 配置键时开放。
- `mainSmall` 与 `mainLarge` 的首选实际模型名必须不同；Planner 已经选择 `mainLarge` 时不开放。
- `request_model_upgrade` 是独立的系统控制工具，不属于 toolset，也不进入 Turn Planner 的常驻工具清单。
- 调用只更新同一个 `runWithTools` 中下一次 provider 请求的期望模型路由；原 working messages、provider replay 元数据、tool call ID 与业务工具选择快照继续沿用。
- provider fallback 已经淘汰的候选不会因普通工具续轮被重新加入；只有期望路由从 `mainSmall` 真正变化到 `mainLarge` 时才重置候选。
- 路由请求写入 `model_route_event`，该事件对 LLM 隐藏，只表示“后续请求已切换到完整模型路由”，不表示完整模型已经成功响应。

相关实现入口：

- `src/conversation/session/sessionModelRoutingPreferences.ts`
- `src/llm/shared/modelSelfUpgrade.ts`
- `src/llm/tools/runtime/modelRoutingTools.ts`
- `src/app/generation/generationSessionOrchestrator.ts`
- `src/app/generation/generationExecutor.ts`
- `src/llm/llmClient.ts`
- `webui/src/components/sessions/SessionModelRoutingControl.vue`

## 资料分层与配置工作态

实例固定角色分为 `persona`、`social`、`embodiment`，按模式逐层读取；动态社交与模拟状态按会话保存。固定角色不再由会话身份覆盖，也不再从旧 persona/RP 表读取。当前角色档案以 `character.sqlite` 为唯一来源。

首次沉浸会话经过四个确认阶段，`session.operationMode.kind = character_config` 记录当前阶段；草稿、revision 和引导认领状态由角色仓库持久化。确认与内容填满分离，用户可以留空确认。只有 `.confirm` 发布固定设定，普通游玩与 OOC 只能改动态属性。配置阶段保留会话历史。

Scenario 的主持资料和世界状态仍然独立保存在当前会话的 `scenarioHostState` 中，不能混入角色自身固定设定。技能配置继续使用自己的 `skill_config` 工作态。

完整边界、分块工具和周期规则见 [三层角色与初始化](character-initialization.md)。

### 会话摘要与 transcript 快照

会话列表读取独立的轻量摘要，不克隆 transcript；订阅通知携带发生变化的 sessionId，只比较该会话的摘要。transcript 条目进入会话后作为不可变值使用；修改排除标记、推理内容或 token 统计时替换条目，不原地修改旧快照。未变化条目的校验、序列化与哈希可以复用，缓存使用弱引用，不维护另一份历史。数组顺序与数据库差异检查仍为线性扫描，尚未引入变更日志或双写索引。

### 实时草稿与正式回复

WebUI 的实时 provider 文本是可撤回草稿，通过 `draft_delta` 展示，通过 `draft_reset` 清除。候选失败、回退或完成时清除该候选草稿；只有通过 provider 响应和工具协议验证的内容才进入正式回复与 transcript。OneBot 的不可撤回发送保持在验证之后，不能将草稿直接用于消息投递。

## 沉浸状态 RP 的回合后维护

主回复与维护模型读取同一份三层固定档案和会话动态状态。代码先推进游戏时钟与周期事件，再按条件调用动态分块维护器。未确认的会话不进行后台初始化或结算。

每次状态写入生成新 revision；提交同时检查状态与角色 revision、会话取消信号。人工修改、重置、删除、读档或全局配置变更后，旧维护结果不会覆盖新状态。任一维护响应失败时不提交半成品，也不清零本轮维护计时器。

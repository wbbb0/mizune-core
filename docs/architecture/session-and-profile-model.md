# 会话、身份与全局资料模型

本文档整理当前仓库已经采纳并在主干代码中落地的运行时模型，重点覆盖会话标识、用户身份、标题语义、全局 profile 与会话工作态之间的边界。

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

## 全局资料分层

当前仓库已经把长期资料拆成三层全局 profile，而不是继续把所有信息塞进单层 `persona`：

- `persona`
  - 只负责 bot 的全局人格底色、说话方式和跨模式全局偏好
- `rpProfile`
  - 只负责 `rp_assistant` 模式下的真人化设定、关系基线与现实契约
- `scenarioProfile`
  - 只负责 `scenario_host` 模式所需的全局资料

这些资料都是实例级全局数据，而不是单个会话状态。

同时，系统单独维护全局准备度：

- `persona`
- `rp`
- `scenario`

它们通过 `GlobalProfileReadinessStore` 持久化，和会话本身的运行工作态分离。

相关实现入口：

- `src/identity/globalProfileReadinessSchema.ts`
- `src/identity/globalProfileReadinessStore.ts`
- `src/persona/personaSchema.ts`
- `src/modes/rpAssistant/profileSchema.ts`
- `src/modes/scenarioHost/profileSchema.ts`

## 会话工作态与草稿语义

当前会话通过 `session.operationMode` 表达当前工作态，而不是继续复用旧的单一 setup 标志。

当前工作态包括：

- `normal`
- `persona_setup`
- `persona_config`
- `mode_setup`
- `mode_config`

其中：

- `persona_setup` / `persona_config` 持有 `Persona` 草稿
- `mode_setup` / `mode_config` 持有模式专属 profile 草稿
- `normal` 表示正常运行态，不应暴露直接写 profile 的运行时入口

关键边界：

- 草稿先存在会话态中，而不是直接写入全局 store
- `confirm` 才会把草稿提交为正式全局资料
- `cancel` 应放弃当前草稿并退出对应配置流程
- 自动进入 setup 由全局 readiness 决定
- 显式配置和首次初始化是不同语义，不应继续混成一套 prompt / 工具入口

相关实现入口：

- `src/conversation/session/sessionOperationMode.ts`
- `src/conversation/session/sessionPersistence.ts`
- `src/conversation/session/sessionMutations.ts`
- `test/session/persistence.test.tsx`
- `test/tools/tool-runtime-features.test.tsx`
- `test/messaging/direct-command-features.test.tsx`

## 运行态约束

当前模型要求以下约束长期成立：

- `normal` 态不直接暴露 profile 写入口
- profile 草稿编辑和正常聊天要走不同 prompt / 工具边界
- 会话标题、会话主体、场景状态、外部身份绑定不再互相串味
- 全局 readiness 与单会话工作态分别建模，不再复用一个字段承担两种职责

如果后续继续扩展模式、身份源或 WebUI 展示，应该沿用上述边界，而不是重新把这些职责混回同一个字段。

# Session Title And Captioner Design

## 背景

当前 Web 会话的新建与展示链路里，`participantLabel` 同时承担了多种不同职责：

- Web 会话标题与列表展示
- 参与者显示名回退
- scenario_host 初始化玩家显示名
- 若干 session identity / summary helper 的展示回退

与此同时，`participantUserId` 也存在语义混杂：

- 在私聊里表示“会话主体用户”
- 在群聊里却被塞成 `groupId`

此外，scenario_host 还把 `state.title` 当成场景标题，而 Web 会话标题又没有独立字段，导致：

- 会话标题、参与者显示名、场景标题互相耦合
- rename 行为无法清晰定义
- 自动标题生成无法自然接到 topic switch / history compression 后

本设计的目标是把这些概念彻底拆开，并引入独立的 `sessionCaptioner`。

## 目标

- 为会话引入独立的 `session.title`
- 为会话主体引入结构化 `participantRef`
- 删除 `participantLabel`
- 删除 `scenario_host.state.title`
- 仅为 `web` 会话引入自动标题生成
- 手动重命名后禁止自动覆盖
- 在会话 info popup 中提供手动重命名与“重新生成标题”
- 新建会话弹窗移除用户 id 语义，记住上次选择的 mode

## 非目标

- 不为非 Web 会话生成或持久化自动标题
- 不修改 planner 的 `topicDecision` 语义来配合标题生成
- 不删除 scenario_host 的 `player` 结构
- 不在这轮实现多平台用户合并

## 数据模型

### Session

`SessionState` 与 `PersistedSessionState` 增加：

- `title: string | null`
- `titleSource: "default" | "auto" | "manual" | null`
- `participantRef: { kind: "user" | "group"; id: string }`

删除：

- `participantLabel`
- `participantUserId`

语义定义：

- `title`
  - Web 会话的唯一标题来源
  - 非 Web 会话可为 `null`
- `titleSource`
  - `default`：默认标题，尚未被手动改名
  - `auto`：由 `sessionCaptioner` 生成
  - `manual`：由用户手动重命名
- `participantRef`
  - 只表达“这个 session 对应哪个主体引用”
  - 不再兼任标题或显示名

示例：

- `web/private`
  - `participantRef = { kind: "user", id: "owner" }`
- `onebot/private`
  - `participantRef = { kind: "user", id: "<internalUserId>" }`
- `onebot/group`
  - `participantRef = { kind: "group", id: "<platformGroupId>" }`

### Scenario Host State

`ScenarioHostSessionState` 删除：

- `title`

保留：

- `player`
- `currentSituation`
- `currentLocation`
- `sceneSummary`
- `inventory`
- `objectives`
- `worldFacts`
- `flags`
- `initialized`
- `turnIndex`

场景标题统一提升到 `session.title`。

## Participant Label 责任拆分

现有 `participantLabel` 的职责按下列方式拆分：

### Web 会话标题展示

改为直接读取 `session.title`。

### OneBot 会话入口展示

改为使用新的 display helper，基于：

- `session.id`
- `participantRef`
- 平台身份 / 群入口信息

推导出展示文案，不再依赖持久化 label 字段。

### Scenario 玩家显示名

改为独立 helper 提供，来源优先级：

1. 用户资料或身份显示名
2. `participantRef.id`

不再借 `participantLabel` 传递。

### 状态页中的“参与者名称”

拆成明确字段：

- `session.title`
- `participantRef`
- 通过 helper 得到的 participant display name（仅在需要时展示）

## 新建 Web 会话

### 弹窗字段

新建会话弹窗保留两个字段：

- `mode`
- `title`

移除任何用户 id / participantLabel 语义。

### 默认 mode

使用浏览器 `localStorage` 记住上次创建时选择的 mode。

规则：

- 打开弹窗时读取上次 mode
- 若本地值无效或 mode 已不存在，则回退到 `rp_assistant`
- 成功创建后写回最近一次选择

### 默认标题

弹窗中的 `title` 输入框根据 mode 显示默认 placeholder：

- `assistant` / `rp_assistant`：`New Chat`
- `scenario_host`：`New Scenario`

规则：

- 默认标题只作为 placeholder 展示，不直接写入输入框值
- 用户未填写时，提交请求中不携带 `title`
- 切换 mode 时同步更新 placeholder
- 若用户手动填写了标题，则以用户输入为准

创建时：

- 若请求未携带 `title`，则后端按 mode 生成默认标题并写入 `session.title`
- 这种情况下 `titleSource = "default"`
- 若用户手动填写了非空标题，则写入该标题，并将 `titleSource = "manual"`

## 会话标题展示

### Web 会话

以下位置统一显示 `session.title`：

- 会话列表
- 聊天页顶部
- 移动端 header
- 会话 info popup

### 非 Web 会话

不使用 `session.title` 作为主展示来源。

显示名继续由 session identity helper 推导，例如：

- 私聊：用户显示名或用户 id
- 群聊：群名或 group id

非 Web 会话不自动生成标题。

## Rename 与手动锁定

会话 info popup 新增：

- 标题输入框
- `保存标题`
- `重新生成标题`

这组控件仅对 `web` 会话显示。

规则：

- `保存标题`
  - 更新 `session.title`
  - 将 `titleSource` 设为 `manual`
- 当 `titleSource === "manual"` 时：
  - 不再自动触发 `sessionCaptioner`
  - topic switch、首次有效对话、scenario setup 完成都不会覆盖标题
- `重新生成标题`
  - 仅对 `web` 会话可见
  - 手动点击后调用 `sessionCaptioner`
  - 成功后更新 `session.title`
  - 将 `titleSource` 设为 `auto`

## Session Captioner

### 命名

新增独立服务与配置节：

- `sessionCaptioner`

这个命名与现有 `imageCaptioner` 风格保持一致。

### 为什么独立于 History Compressor

不复用 history compressor 配置，原因：

- history compressor 目标是“压缩旧历史”
- session captioner 目标是“生成短、稳、可读的标题”
- 两者的输入窗口、输出长度、风格约束、失败策略不同

### 配置建议

新增配置节：

- `sessionCaptioner.enabled`
- `sessionCaptioner.modelRef`
- `sessionCaptioner.maxInputMessages`
- `sessionCaptioner.maxTitleLength`
- `sessionCaptioner.stylePrompt`

默认 prompt 风格要求：

- 输出简短描述性标题
- 避免小说名、文艺腔、夸张语气
- 更像任务标签、主题摘要或工作标题
- 不带引号

## Captioner 触发时机

### 首次有效对话后

仅对 `web` 的 `assistant` / `rp_assistant` 会话：

- 当前标题为默认标题
- `titleSource !== "manual"`
- 已有足够消息窗口可供概括

则触发一次 `sessionCaptioner`。

这里不依赖 planner 的 `new_topic`。

### Topic Switch 后

当 planner 真实给出 `topic_switch`，并且 `compactOldHistoryKeepingRecent(...)` 已完成后：

- 若会话是 `web`
- 且 `titleSource !== "manual"`

则基于压缩后保留下来的 recent window 触发 `sessionCaptioner`。

这样标题对应的是当前活动话题窗口，而不是刚被压缩掉的旧历史。

### Scenario Setup 完成后

对于 `web` 的 `scenario_host` 会话：

- setup phase 完成时生成一次 `session.title`
- 不再写 `state.title`

输入以 setup 结果和当前 scenario state 的结构化字段为主，要求输出偏描述性，不要像小说书名。

### 手动触发

用户可在会话 info popup 中点击“重新生成标题”。

此按钮是唯一允许在 `manual` 之后重新调用 captioner 的入口；调用成功后 `titleSource` 更新为 `auto`。

## Planner 与 Topic Switch 语义

不为了标题生成而修改 planner 的 `topicDecision`。

特别是：

- “空历史时强制视为 `new_topic`” 不在本设计中采用
- 标题生成只是读取现有 session 状态与真实的 topic switch 结果

原因：

- `topicDecision` 应该继续只表达 planner 对话题边界的判断
- 不应为了触发副作用而篡改 planner 语义

## Scenario Host 调整

### Setup

scenario setup phase 不再写 `state.title`，而是写：

- `session.title`
- `session.titleSource = "auto"`（若由 captioner 生成）

### State Editor

`ScenarioHostStateEditor` 移除标题编辑项。

保留：

- 当前局势
- 当前地点
- 场景摘要
- 背包
- 目标
- 世界事实
- flags

### Tools

`update_scenario_state` 不再允许更新 `title`。

如果以后需要从工具层改会话标题，应走独立的 session title tool / API，而不是 scenario state tool。

## Internal API

### Session Summary / Detail

返回结构新增：

- `title`
- `titleSource`
- `participantRef`

删除：

- `participantLabel`
- `participantUserId`

### Create Session

创建 Web 会话接口输入改为：

- `modeId`
- 可选 `title`

不再接收 `participantLabel`。

### Rename Session Title

新增接口，例如：

- `PATCH /api/sessions/:sessionId/title`

请求体：

- `title: string`

行为：

- 仅修改 `session.title`
- 设置 `titleSource = "manual"`
- 持久化会话

### Regenerate Session Title

新增接口，例如：

- `POST /api/sessions/:sessionId/title/regenerate`

行为：

- 仅允许 `web` 会话
- 调用 `sessionCaptioner`
- 成功后更新 `session.title`
- 设置 `titleSource = "auto"`

## WebUI

### Create Session Dialog

调整为：

- 移除 participantLabel 语义
- 增加明确的 `标题` 输入框
- mode 默认值来自 `localStorage`
- title 默认值由 mode 决定

### Sessions Page

以下位置改读 `session.title`：

- 会话列表项
- 当前选中会话页头
- 移动端 header

### Session Info Popup

在现有“切模式 / 删除”弹窗中新增：

- 标题输入框
- 保存标题按钮
- 重新生成标题按钮

这些标题相关控件仅在 `web` 会话上显示；非 Web 会话仍只保留现有可用操作。

### Session State Panel

展示字段改为：

- 标题
- 标题来源
- participantRef

不再展示 `participantLabel`。

## 实现顺序

1. 引入 `session.title`、`titleSource`、`participantRef`
2. 替换 persistence / session summary / session detail / WebUI 类型
3. 删除 `participantLabel`
4. 将 scenario_host `state.title` 提升到 `session.title`
5. 改造新建会话弹窗与 info popup
6. 引入 `sessionCaptioner` 与配置
7. 接入首次命名、topic switch 后重命名、scenario setup 后命名
8. 删除旧 helper 与旧测试，补齐新测试

## 风险与注意事项

### participantRef 影响面大

这次不只是标题重构，还涉及 session 主体模型收口，因此：

- session identity helper
- session persistence
- WebUI session list/detail
- scenario_host 默认 player

都会一起改动。

### Scenario Title 迁移

删除 `state.title` 时要同步更新：

- prompt builder
- scenario tools
- state editor
- API 类型
- 测试

不能留下半套旧字段。

### Web / Non-Web 分界

自动标题只对 `web` 会话开放，前后端都要同时收口，避免出现：

- UI 不显示按钮，但 API 还能触发
- 非 Web 会话被错误写入标题并参与展示

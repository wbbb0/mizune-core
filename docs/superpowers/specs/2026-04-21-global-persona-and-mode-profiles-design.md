# Global Persona And Mode Profiles Design

## 背景

当前项目的 `persona` 仍是单层结构，同时承担了以下几类语义：

- 实例级的基础人格与长期口吻
- RP 模式下的身份、关系、外貌与硬规则
- 初始化阶段的唯一补全对象

在引入多模式语义后，这种结构已经开始失真：

- `assistant`、`rp_assistant`、`scenario` 实际依赖的设定并不相同
- RP 专属要求不应该泄漏给 `assistant` 和 `scenario`
- 初始化、后续配置、正常运行三种工作语义已经不适合继续共用一组 prompt 和一组写工具
- 单一 `setupState` 已不足以表达“全局 persona 是否完成”和“模式专属资料是否完成”

本设计的目标，是把实例级 persona 与模式专属全局资料拆开，并为 setup / config / normal 三种运行语义建立清晰边界。

## 目标

- 将当前单层 `persona` 拆分为全局 `persona`、全局 `rpProfile`、全局 `scenarioProfile`
- 明确三种模式对配置的读取范围
- 为首次初始化与后续显式配置建立分离的 prompt 和工具边界
- 让 `rp_assistant` 与 `scenario` 在缺少模式专属资料时自动进入对应 setup
- 在正常运行态彻底禁止模型直接修改 persona / mode profile
- 用独立的 readiness 和会话工作态替代当前单一 setup 语义

## 非目标

- 这轮不兼容旧 `persona.json` 或旧 setup 状态文件
- 这轮不保留旧的“单层 persona 即全部设定”语义
- 这轮不把 `rpProfile` 或 `scenarioProfile` 做成会话级数据
- 这轮不允许普通聊天中的自然语言直接落盘修改长期设定

## 核心设计原则

### 1. persona 只表示全局人格与基础身份

`persona` 以后只表示“所有模式都成立的实例级自我描述”。

凡是仅在 RP 模式下成立的附加设定，都不得继续放入 `persona`。

### 2. 模式专属资料是全局 profile，不是会话状态

`rpProfile` 和 `scenarioProfile` 与 `persona` 同级，作用域都是实例级全局数据。

它们不是 session state，也不随单个会话变化。

### 3. normal 态绝不提供写入口

非 `setup` / `config` 工作态下，模型不能看到任何 persona / mode profile 编辑工具。

owner 在正常聊天中提出修改要求时，模型只能引导用户使用显式指令进入配置态；非 owner 只能被拒绝。

### 4. setup 与 config 是不同语义

`setup` 的目标是从未完成状态收集并补齐核心字段；`config` 的目标是读取现状后做显式、局部的增删改。

两者必须使用不同的 system prompt 和不同的行为约束。

### 5. 全局 readiness 与会话工作态分离

“某份资料是否已完成”与“当前会话是否正处于配置流程”是两种不同语义，不能继续挤在一个字段里。

## 数据模型

### persona

`persona` 只保留所有模式共用的字段：

- `name`
- `coreIdentity`
- `personality`
- `interests`
- `background`
- `speechStyle`

说明：

- 旧 `role` 字段重命名为 `coreIdentity`
- 旧 `appearance` 从 `persona` 移出
- 旧 `rules` 不再保留为全局兜底字段

### rpProfile

`rpProfile` 只服务 `rp_assistant`：

- `appearance`
- `premise`
- `relationship`
- `identityBoundary`
- `styleRules`
- `hardRules`

说明：

- `appearance` 属于 RP 身份设定，不再进入全局 persona
- “绝不暴露自己是模型”“按真人身份自处”等要求必须属于 `rpProfile`

### scenarioProfile

`scenarioProfile` 只服务 `scenario`：

- `theme`
- `hostStyle`
- `worldBaseline`
- `safetyOrTabooRules`
- `openingPattern`

## 读取边界

- `assistant` 只读取 `persona`
- `rp_assistant` 读取 `persona + rpProfile`
- `scenario` 读取 `persona + scenarioProfile`

模式依赖顺序：

- 所有模式都先依赖 `persona.ready`
- 只有在 `persona.ready` 之后，`rp_assistant` 才进一步依赖 `rp.ready`
- 只有在 `persona.ready` 之后，`scenario` 才进一步依赖 `scenario.ready`

强约束：

- `assistant` 和 `scenario` 完全看不到 `rpProfile`
- `rp_assistant` 不读取 `scenarioProfile`

## 完成标准

### persona readiness

`persona.ready` 的最小条件：

- `name`
- `coreIdentity`
- `personality`
- `speechStyle`

### rp readiness

`rp.ready` 的最小条件：

- `premise`
- `identityBoundary`
- `hardRules`

### scenario readiness

`scenario.ready` 的最小条件：

- `theme`
- `hostStyle`
- `worldBaseline`

## 状态模型

### 全局 readiness

全局 readiness 单独记录，不与会话工作态混用：

```ts
type ProfileReadiness = "uninitialized" | "ready"

type GlobalProfileReadiness = {
  persona: ProfileReadiness
  rp: ProfileReadiness
  scenario: ProfileReadiness
}
```

### 会话工作态

当前会话单独记录自己是否正处于 setup / config：

```ts
type SessionOperationMode =
  | { kind: "normal" }
  | { kind: "persona_setup" }
  | { kind: "mode_setup"; modeId: "rp_assistant" | "scenario" }
  | { kind: "persona_config" }
  | { kind: "mode_config"; modeId: "rp_assistant" | "scenario" }
```

说明：

- 用户视角上仍可理解为五种工作态
- 实现上不能收敛为单一 setup state 枚举

## 进入与退出流程

### 首次初始化

- 若 `persona` 未完成，owner 私聊自动进入 `persona_setup`
- `assistant` 只有在 `persona.ready` 后才进入正常运行

### 模式自动 setup

- 若 `persona` 尚未完成，则优先进入 `persona_setup`，而不是直接进入模式专属 setup
- 进入 `rp_assistant` 时，如果 `rpProfile` 未完成，当前会话自动进入 `mode_setup(rp_assistant)`
- 进入 `scenario` 时，如果 `scenarioProfile` 未完成，当前会话自动进入 `mode_setup(scenario)`

### 显式配置

owner 可以通过显式指令进入配置态：

- `.config persona`
- `.config rp`
- `.config scenario`

配置态统一基于临时草稿运行，而不是直接修改已保存配置：

- `setup` 进入时加载空白草稿
- `config` 进入时加载当前已保存配置的副本草稿
- 配置过程中的字段增删改默认只作用于草稿
- 只有 `.confirm` 才会把草稿持久化为正式配置
- `.cancel` 会丢弃草稿，回退到进入配置前的已保存状态

### confirm / cancel

- `.confirm`
  - 提交当前 setup / config 草稿的变更
  - 更新对应 readiness
  - 清除当前会话工作态
  - 清空当前 session 历史
  - 返回明确提示“配置已确认，当前会话历史已清空”
- `.cancel`
  - 放弃当前 setup / config 草稿
  - 清除当前会话工作态
  - 清空当前 session 历史
  - 返回明确提示“已退出配置流程，当前会话历史已清空”

## 指令设计

建议保留一组显式、低歧义的入口指令：

- `.setup persona`
- `.setup rp`
- `.setup scenario`
- `.config persona`
- `.config rp`
- `.config scenario`
- `.confirm`
- `.cancel`

规则：

- `.setup xxx` 仅用于对应资料尚未完成的情况；若已完成，应提示改用 `.config xxx`
- `.setup xxx` 仅 owner 可用
- `.config xxx` 仅 owner 可用
- `.confirm` / `.cancel` 只在当前会话处于 setup / config 工作态时可用

额外语义：

- `.setup xxx` 表示以空白草稿重新开始该对象配置
- `.config xxx` 表示以当前已保存配置为基础进入编辑

## Prompt 分层

### normal

正常运行态：

- 不携带配置写入目标
- 不暴露 persona / mode profile 编辑工具
- owner 提修改长期设定时，只引导使用 `.config ...`
- 非 owner 提修改时直接拒绝

### persona_setup

目标：

- 从空白或近空白状态补齐 `persona` 必需字段
- 主动围绕缺失字段提问
- 不处理 `rpProfile` 或 `scenarioProfile`
- 写入目标是临时 `persona` 草稿，而不是正式存储

### mode_setup

目标：

- 针对当前模式补齐专属全局 profile
- `mode_setup(rp_assistant)` 只处理 `rpProfile`
- `mode_setup(scenario)` 只处理 `scenarioProfile`
- 写入目标是对应模式的临时 profile 草稿

### persona_config

目标：

- 先读取当前 `persona`
- 基于 owner 的显式要求做局部修改
- 不默认重新收集所有字段
- 操作对象是“当前已保存 persona 的副本草稿”

### mode_config

目标：

- 先读取当前模式的 profile
- 仅修改对应模式的数据
- 不跨模式写入
- 操作对象是“当前已保存 mode profile 的副本草稿”

## 工具暴露边界

### normal

不暴露以下任何写工具：

- `patch_persona`
- `clear_persona_field`
- `patch_rp_profile`
- `clear_rp_profile_field`
- `patch_scenario_profile`
- `clear_scenario_profile_field`

### persona_setup / persona_config

只暴露 persona 相关读写工具：

- `get_persona`
- `patch_persona`
- `clear_persona_field`
- 可选：`send_setup_draft`

这些工具在配置态中只操作临时草稿，不直接写正式配置。

### mode_setup(rp_assistant) / mode_config(rp_assistant)

只暴露 `rpProfile` 相关读写工具：

- `get_rp_profile`
- `patch_rp_profile`
- `clear_rp_profile_field`
- 可选：`send_setup_draft`

这些工具在配置态中只操作临时草稿，不直接写正式配置。

### mode_setup(scenario) / mode_config(scenario)

只暴露 `scenarioProfile` 相关读写工具：

- `get_scenario_profile`
- `patch_scenario_profile`
- `clear_scenario_profile_field`
- 可选：`send_setup_draft`

这些工具在配置态中只操作临时草稿，不直接写正式配置。

## 行为规则

### owner 在 normal 态提出修改请求

如果 owner 在正常聊天里表达：

- “以后你的人设改成……”
- “把你的 RP 设定改成……”
- “把 scenario 的默认世界改成……”

模型只能：

- 说明当前聊天态不会直接修改长期配置
- 引导用户使用正确的 `.config ...` 指令

模型不能：

- 直接落盘
- 在正文中承诺“我已经记住了”
- 伪装成已完成配置写入

### 非 owner 的修改请求

非 owner 不得触发 persona / profile 配置流程。

模型应以合适方式说明：

- 当前用户没有修改长期设定的权限
- 如需调整，请由 owner 执行对应配置指令

## 状态与存储重命名建议

当前 `setupState` 已不足以表达真实语义。

建议拆分为：

- 全局 readiness store
  - 例如 `globalProfileReadinessStore`
- 会话工作态
  - 例如 session runtime 中的 `operationMode`

不建议把新的全局 readiness 命名为 `rpSetupState`，因为它不只服务 RP。

## 兼容与迁移

本次改动不兼容旧数据。

处理策略：

- 不保留旧 `persona.json` 自动迁移逻辑
- 不保留旧 setup-state 文件兼容层
- 旧数据由使用者手动移走后，按新结构重新初始化

这意味着：

- 可直接删除旧字段、旧分支、旧判定
- 测试、文档、WebUI 文案应同步更新到新语义

## WebUI 与文案影响

需要同步调整的用户可见语义包括：

- `persona` 页面或编辑器文案改为“全局 persona”
- 新增 `rpProfile` 与 `scenarioProfile` 的查看/编辑入口
- setup / config 状态在会话页中的展示语义应改为当前工作态，而不是笼统的 `setupState`
- `.confirm` / `.cancel` 的返回提示需明确会话历史已被清空

## 测试要求

至少应覆盖以下行为：

- `persona` 未完成时 owner 私聊自动进入 `persona_setup`
- `rp_assistant` 在 `rpProfile` 缺失时自动进入 `mode_setup(rp_assistant)`
- `scenario` 在 `scenarioProfile` 缺失时自动进入 `mode_setup(scenario)`
- normal 态下不暴露任何 persona / profile 写工具
- owner 在 normal 态提出修改请求时只会被引导到 `.config ...`
- 非 owner 的修改请求被拒绝
- `.confirm` 会写入、退出工作态并清空 session
- `.cancel` 会退出工作态并清空 session
- `assistant` 看不到 `rpProfile`
- `scenario` 看不到 `rpProfile`

## 风险与控制

### 风险 1：字段继续串味

如果继续保留 `role`、`rules` 这类过宽字段名，后续仍会把 RP 或 scenario 规则写回全局 persona。

控制：

- 用更明确的字段名替代含糊字段
- 删除全局兜底 `rules`

### 风险 2：运行态偷偷恢复写入口

如果 toolset 裁剪不严格，模型会在 normal 态继续修改长期配置。

控制：

- 以工作态驱动工具集选择
- normal 态默认完全无 profile 写工具

### 风险 3：会话工作态与 readiness 再次混用

如果把“正在配置”和“是否已完成”重新合并到一个字段，状态语义会再次变脏。

控制：

- readiness 和 operation mode 保持独立存储与独立判定

## 结论

本设计将当前单层 persona 与单一 setup 语义拆解为：

- 一份全局 `persona`
- 两份模式专属全局 profile：`rpProfile`、`scenarioProfile`
- 一组全局 readiness 状态
- 一组会话级工作态

这样可以在不引入兼容层的前提下，把实例人格、RP 扮演要求、Scenario 主持设定、setup/config 工作流和正常运行态彻底分离，为后续实现提供清晰边界。

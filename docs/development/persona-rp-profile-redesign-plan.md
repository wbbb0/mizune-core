# Persona / RP Profile 重构实施计划

本文档用于约束下一轮 `persona` 与 `rpProfile` 字段重构的实施顺序、边界和验收标准，避免在实现过程中重新堆叠模糊字段、兼容分支和 prompt 特例。

## 目标

本轮重构的目标是把全局人格底座与 RP 模式下的“具体真人化设定”彻底拆开：

- `persona` 只保留跨所有模式都成立的人格底座
- `rpProfile` 承担 RP 模式中“这个人是谁、怎么生活、与用户是什么关系、如何维持现实感”的全部信息
- 不保留模糊的单一“身份”字段
- 不为旧字段、旧数据、旧 prompt 口径保留兼容层

## 新字段边界

### `persona`

`persona` 只保留以下字段：

- `name`
- `temperament`
- `speakingStyle`
- `globalTraits`
- `generalPreferences`

字段语义约束：

- 不放职业、居住状态、外貌、身体感、社会关系
- 不放 RP 世界中的具体生活事实
- 不放只在某个模式成立的角色约束

### `rpProfile`

`rpProfile` 使用以下字段：

- `selfPositioning`
- `socialRole`
- `lifeContext`
- `physicalPresence`
- `bondToUser`
- `closenessPattern`
- `interactionPattern`
- `realityContract`
- `continuityFacts`
- `hardLimits`

字段语义约束：

- `selfPositioning` 表达自我理解与稳定气质，不再用一个泛化“身份”字段承担
- `socialRole` 表达社会位置或职业角色
- `lifeContext` 表达日常生活环境与生活状态
- `physicalPresence` 表达外在存在感与身体感
- `bondToUser` 表达与用户的默认关系基线
- `closenessPattern` 与 `interactionPattern` 分别表达亲密推进方式与互动方式
- `realityContract` 表达“作为现实中的真人存在”这一前提的维持方式
- `continuityFacts` 只保存跨会话必须稳定的事实锚点
- `hardLimits` 只保存绝对不能突破的硬边界

## 实施硬约束

本轮实现必须满足以下硬约束：

- 不做老数据迁移
- 旧 `persona` / 旧 `rpProfile` 直接视为无效数据
- schema 直接换成新字段，不保留旧字段双读双写
- `setup/config` prompt 不提供具体内容示例，避免模型样学样
- prompt 主要提供“当前草稿状态、缺失字段、本轮目标、行为约束”，而不是教学式模板
- 代码修改尽量以重构方式推进，不在旧逻辑上继续叠加特判

## 影响面

本轮重构会影响以下几层：

- schema 与持久化
  - `src/persona/personaSchema.ts`
  - `src/modes/rpAssistant/profileSchema.ts`
  - profile store 与 editor schema 导出
- readiness 与全局状态
  - `persona.ready`
  - `rp.ready`
  - 基于字段缺失的完成判断
- 配置工作流
  - `setup/config` 草稿结构
  - `confirm/cancel` 后的 readiness 更新
- prompt 组装
  - `persona_setup`
  - `persona_config`
  - `rp setup/config`
  - 正常 `rp_assistant`
- 工具层
  - `get/patch/clear persona`
  - `get/patch/clear rp profile`
  - `send_setup_draft`
- 测试与文档
  - schema/readiness
  - prompt 快照与工具行为
  - README / editor 资源说明 / 架构文档

## 实施阶段

### 阶段 1：字段与 schema 收口

目标：

- 先把字段边界钉死
- 让类型系统、schema 和空草稿结构先统一

实施内容：

- 重写 `personaSchema`
- 重写 `rpProfileSchema`
- 更新 `createEmpty*`、`editable*FieldNames`、字段标签与缺失字段判断
- 重新定义 `persona.ready` 与 `rp.ready` 所需字段
- 明确旧 schema 数据解析失败时直接返回未初始化，而不是做兼容修补

完成标准：

- 新字段在类型层、schema 层、空草稿层完全一致
- 旧字段不再出现在类型、常量和 schema 标签中

### 阶段 2：草稿与配置工作流对齐

目标：

- 让配置流程直接围绕新字段工作
- 避免旧字段残留在工作态和确认逻辑里

实施内容：

- 更新 `persona_setup` / `persona_config` 草稿结构
- 更新 `mode_setup(rp)` / `mode_config(rp)` 草稿结构
- 调整 `confirm` 持久化后的 readiness 判定
- 检查 `patch_*` / `clear_*` 工具的字段白名单和返回消息
- 确保 `.setup` 从空草稿开始、`.config` 从已保存配置副本开始的语义保持不变

完成标准：

- 全部配置态工具只接受新字段
- readiness 更新只基于新字段
- 旧字段名不再出现在 direct command 和 profile tool 行为中

### 阶段 3：prompt 结构重写

目标：

- 让弱模型也能稳定完成 setup/config
- 让正常 `rp_assistant` 真正消费新的 `persona + rpProfile`

实施内容：

- 重写 `persona_snapshot` 与 `rp_profile_snapshot` 的渲染内容
- 重写 `persona_setup_mode`、`persona_config_mode`
- 重写 `rp_profile_setup_mode`、`rp_profile_config_mode`
- 重写正常 `rp_assistant` 的 profile 注入 section
- prompt 中不再写具体人设示例，只保留流程约束、字段目标、行为限制
- 把字段收集顺序写成“字段组推进规则”，避免模型一轮追问太多项

完成标准：

- setup/config prompt 不含具体内容示例
- prompt 只围绕当前草稿、缺失字段和本轮目标组织
- 正常 `rp_assistant` 明确看到 `persona + rpProfile`

### 阶段 4：编辑器与展示收口

目标：

- 让 WebUI / 编辑器看到的新 schema 与运行时字段保持一致

实施内容：

- 更新 schema `title` / `description`
- 更新 editor service 暴露的资源结构
- 检查数据编辑器展示名是否与新字段一致
- 删除旧字段展示文案

完成标准：

- 编辑器中不再显示旧字段
- 标题和说明与新的字段语义一致

### 阶段 5：测试与文档收尾

目标：

- 用测试把新边界钉死
- 删除旧语义在文档中的残留

实施内容：

- 更新 persona/rp profile schema 相关测试
- 更新 setup/config prompt 相关测试
- 更新 readiness、tool runtime、direct command 相关测试
- 更新 README 与架构文档中的字段说明
- 明确记录“旧数据无效化，不做迁移”

完成标准：

- `npm run typecheck:all`
- `npm run test`
- 文档中不再出现旧字段口径

## prompt 设计约束

为提高弱模型稳定性，本轮 prompt 必须遵循以下约束：

- 不给具体内容示例
- 不用示范式问答
- 每轮最多推进一个字段组
- 每轮最多追问一到两个紧密相关字段
- 如果信息不足，只能追问，不能补写
- 每次修改后发送当前草稿快照并等待用户
- `send_setup_draft` 后不继续在同一轮追问长串字段

## 风险点

### readiness 与草稿结构不一致

如果新字段改了，但 readiness 仍引用旧字段，会导致：

- 明明已经完成草稿却无法进入正常模式
- 或者资料明显不完整却被错误标记为 `ready`

因此需要优先统一 schema、缺失字段判断、确认后的 readiness 更新。

### prompt 仍残留旧字段语义

如果 prompt 还在提旧的“身份边界”“前提”“关系”等旧字段名，模型会混淆新字段职责。

因此 prompt 重写不能只改 section 标题，必须同步改快照、缺失字段提示和流程约束。

### editor / 测试 残留旧字段

如果 editor 和测试仍基于旧字段，会导致：

- 配置体验与运行时不一致
- 重构后测试仍在验证已经废弃的字段口径

因此本轮必须同步删改测试和文档，不保留过时断言。

## 验收标准

本轮实施完成后，应满足：

- `persona` 只包含五个全局字段
- `rpProfile` 只包含十个 RP 专属字段
- 旧字段在源码、prompt、测试、文档、编辑器中全部消失
- 旧数据不迁移，直接被识别为未初始化
- `setup/config` prompt 不含具体内容示例
- 正常 `rp_assistant` 运行态明确消费 `persona + rpProfile`
- 所有变更以较清晰的模块重构方式落地，而不是在旧字段上继续打补丁

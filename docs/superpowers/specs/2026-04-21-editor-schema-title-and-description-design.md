# Editor Schema Title And Description Design

## 背景

当前配置页和数据页的 schema 编辑器已经具备 `title` 与 `description` 元数据通路，但仓库内大多数编辑器 schema 仍未系统补齐中文文案：

- 页面主标签多数仍回退到字段 key
- `description` 通路存在，但实际 hover 说明覆盖很少
- 配置资源与数据资源的命名风格不统一

这导致编辑器虽然可用，但可读性不稳定，尤其是在层级较深、字段名偏技术化的场景下，用户需要反复在 key 名和真实语义之间做映射。

本设计的目标，是把编辑器 schema 的中文命名体系收敛为一套明确约定：

- `title` 负责页面上展示的名称
- `description` 负责 HTML `title` 属性对应的 hover 说明
- 配置与数据编辑器资源共用同一套命名原则

## 目标

- 为配置编辑器和数据编辑器涉及的 schema 系统补齐中文 `title`
- 只为对象分组节点和少数不直观字段补充 `description`
- 保持现有编辑器显示优先级不变：名称来自 `title`，hover 来自 `description`
- 让后端导出的 `schemaMeta` 与前端展示语义保持一致
- 为后续新增 schema 建立清晰的中文命名规则

## 非目标

- 这轮不改变 schema 系统的元数据结构
- 这轮不引入自动翻译或字段名自动中文化逻辑
- 这轮不让 `description` 参与主标签渲染
- 这轮不重构配置加载、解析或 editor API
- 这轮不顺手修复与本任务无关的 WebUI 基线失败测试

## 设计原则

### `title` 只承担“名称”职责

页面上用户首先看到的字段名、分组名、数组项名，应始终来自：

- 显式传入的 `headerLabel`
- 否则来自 schema 的 `title`
- 再否则才回退到字段 key

不把 `description` 混入主名称选择，避免同一字段在不同层级产生不稳定显示。

### `description` 只承担“解释”职责

`description` 只用于 hover 时的 HTML `title` 属性，不承担正文展示职责。

因此 `description` 需要克制使用：

- 对象分组：说明这一组配置/数据的职责
- 少数容易误解的字段：说明取值含义、作用范围或行为差异
- 直观字段不强行补一句废话式说明

### 中文文案优先准确、稳定，不追求花哨

文案要优先满足编辑器长期维护：

- 尽量与仓库内现有中文术语一致
- 避免同义词混用，例如“启用/开启”“群成员/群成员缓存”反复变化
- 字段名短而准，hover 说明补充上下文

### 不新增兼容层

本次只补元数据，不保留旧命名体系，也不做双轨显示逻辑。已有页面和接口继续消费统一的 `schemaMeta.title` / `schemaMeta.description`。

## 覆盖范围

本次覆盖所有编辑器资源对应的 schema，至少包括：

- `src/config/configModel.ts`
- `src/persona/personaSchema.ts`
- `src/identity/userSchema.ts`
- `src/identity/whitelistSchema.ts`
- `src/requests/requestSchema.ts`
- `src/identity/setupStateSchema.ts`
- `src/identity/groupMembershipSchema.ts`
- `src/runtime/resources/runtimeResourceSchema.ts`
- `src/runtime/scheduler/jobSchema.ts`
- `src/memory/globalRuleEntry.ts`
- `src/llm/prompt/toolsetRuleStore.ts`

如果在 editor service 中还能追到其他实际暴露给页面编辑的 schema，也一并纳入本轮统一补齐。

## 命名与描述规则

### 对象 / 分组节点

- 必须有中文 `title`
- 可根据复杂度决定是否补 `description`
- 若该分组下字段多、语义抽象或存在行为边界，优先补一句说明

示例方向：

- `conversation` -> `会话`
- `historyCompression` -> `历史压缩`
- `resultPolicy` -> `结果策略`

### 基础字段

- 原则上都补中文 `title`
- 只有“不看代码就容易误解”的字段才补 `description`

典型需要说明的字段包括：

- 带布尔开关但行为不直观的字段
- 带阈值、超时、倍率、随机因子之类的调节项
- 带运行时范围或覆盖关系的字段

### 数组与记录项

- 容器节点本身补 `title`
- item/value schema 若会在页面上作为独立节点显示，也补对应 `title`
- 不试图用 schema `description` 覆盖数组项默认的“项目 N”文案

数组项显示规则仍保持现状；如果后续要把数组项标题提升为领域名，单独设计，不在本轮混做。

## 前端展示语义

前端编辑器维持现有语义：

- 主显示名称：`headerLabel ?? schema.title ?? fieldKey`
- hover 文本：`schema.description`

本轮最多只做小修正：

- 若某些 group/array/record 容器当前没有把 `description` 映射到 HTML `title`，补齐为一致行为
- 不改变数组项标题逻辑
- 不让 `description` 替代 `title`

## 实现边界

### 后端

后端只做 schema 元数据补齐，不改这些机制：

- `BaseSchema.title()`
- `BaseSchema.describe()`
- `SchemaMeta` 结构
- `buildUiTreeFromMeta()`
- `editorService` 的导出与装配逻辑

### 前端

前端只允许做两类改动：

- 为已有 `title` / `description` 通路补一致性测试
- 如有必要，对 `SchemaNode.vue` 做极小修补，使 hover 行为在 group/field/container 上保持一致

不做新的显示策略抽象。

## 测试策略

本轮需要补充或更新以下层面的测试：

### Schema 元数据导出

验证 `exportSchemaMeta()` / editor model 导出的关键节点包含：

- 预期的中文 `title`
- 仅在需要处存在的 `description`

### Editor API / Internal API

验证配置编辑器与数据编辑器载入后，返回的 `schemaMeta` 中能看到关键中文标题，确保不是只在局部 schema 定义里补了文案但没有透传到页面层。

### WebUI 渲染

至少覆盖一类配置资源和一类数据资源，验证：

- 页面优先使用 `title` 展示名称
- `description` 不参与正文显示
- hover 仍从 `description` 取值

## 验证与交付要求

实现完成前至少运行：

- `npm run typecheck:all`
- `npm run test`

当前 worktree 基线中已存在 2 个与 `SectionHost` 重构相关的 WebUI 失败测试；本任务实现时需要区分：

- 本任务新增/修改的测试必须通过
- 若仍保留这 2 个基线失败，最终说明中必须明确标注其为既有失败，不得误报“全量测试通过”

## 风险

### 文案补齐不一致

若不同 schema 文件分别采用不同术语，会让页面命名再次碎片化。实现时需要先统一高频词，例如“启用”“超时”“白名单”“缓存”“规则”“资源”等。

### 说明文案过量

若把 `description` 补到几乎所有字段，hover 会退化为噪音，反而影响可用性。本轮必须坚持“对象分组优先、少数字段例外”的克制策略。

### 测试脆弱性

若 WebUI 测试直接断言大段渲染文本，后续轻微文案调整会让测试频繁失效。优先断言关键字段标题与 hover 语义，不对整页静态文本做过强绑定。

## 成功标准

- 配置页和数据页中的编辑器主标签大部分不再回退为原始英文 key
- 关键对象分组拥有清晰中文名称，必要时有 hover 说明
- `title` 与 `description` 的职责边界清晰且在实现、测试、页面行为中保持一致
- 不引入新的 schema 元数据机制或兼容层

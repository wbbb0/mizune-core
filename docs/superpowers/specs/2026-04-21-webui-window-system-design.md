# WebUI Workbench 统一窗口系统设计

## 背景

当前 WebUI 的弹窗能力仍是“每个组件自己 teleport 到 `body` 并自行管理开关”的模式：

- `WorkbenchDialog.vue` 负责单实例弹窗外壳、遮罩、`Escape` 关闭和 `body` 滚动锁定
- `CreateSessionDialog.vue`、`ImagePreviewDialog.vue`、`ChatPanel.vue` 中的确认框都各自封装内容与行为
- 不同弹窗之间没有统一的层级、聚焦、父子关系和移动端栈管理
- 当前 workbench 已经开始收敛为统一壳子，但弹窗仍是页面内的局部实现，无法自然抽成共享 workbench 能力

接下来要支持的目标比“单个弹窗组件”大得多：

- 多窗口同时存在
- 桌面端拖拽、点击置顶
- 父子窗口关系
- 父窗口在有子窗口时降对比度且内容不可交互，但仍允许拖动
- 移动端按打开顺序仅显示栈顶窗口，不允许拖拽或手动改层级
- 用统一的、带完整类型的描述结构创建确认框、表单框、图片预览和自定义工具面板

因此，这一轮不继续增强现有 `WorkbenchDialog`，而是设计一个统一的 workbench 窗口系统。

## 目标

- 建立 workbench 级全局窗口管理器，统一渲染所有窗口
- 建立完整类型标注的窗口定义 DSL，统一描述字段、按钮和自定义组件块
- 支持桌面端多窗口并存、拖拽、点击置顶和父子窗口关系
- 支持移动端栈式显示，只显示栈顶窗口
- 让按钮回调与关闭结果都能拿到完整表单值
- 为将来抽进共享 workbench 包保留稳定边界

## 非目标

- 这轮不直接复用后端 `src/data/schema` 的运行时实现
- 这轮不做自由停靠、吸附、分屏等桌面窗口管理能力
- 这轮不支持任意像素/百分比尺寸覆盖
- 这轮不设计独立于 workbench 的第二套弹窗体系
- 这轮不做与路由同步的窗口恢复机制

## 设计结论

### 结论 1：统一成一个窗口系统，而不是“基础弹窗 + 各种特例”

确认框、表单弹窗、图片预览、自定义工具面板、子弹窗都走同一套系统。

这套系统由两层组成：

1. `WindowManager / WindowHost / WindowSurface`
   - 负责窗口栈、层级、父子关系、拖拽、移动端行为
2. `DialogRenderer`
   - 负责根据定义对象渲染字段、按钮和自定义块

换句话说，窗口系统负责“怎么显示与管理窗口”，对话 DSL 负责“窗口里放什么内容、按什么按钮会返回什么结果”。

### 结论 2：参考后端 schema 的元数据思路，但不直接复用运行时

后端 `src/data/schema` 的职责是数据模型、校验、解析与默认值；前端窗口系统的职责是 UI 结构、交互行为、异步动作和结果返回。

两者边界不同，直接复用运行时会把前后端耦合在一起，并且很难自然表达：

- 按钮动作
- 自定义内容块
- 父子窗口关系
- 桌面/移动端差异
- Promise 风格结果返回

因此本设计采用：

- 前端独立 `DialogSchema`
- 可选 `SchemaMeta -> DialogField[]` 适配器

共享“元数据描述格式的风格”，不共享“执行引擎”。

## 总体架构

### WindowManager

`WindowManager` 是唯一的数据源，负责：

- 打开/关闭窗口
- 维护窗口顺序与激活窗口
- 维护父子关系
- 维护桌面端位置状态
- 维护窗口结果 Promise 的 resolve/reject
- 维护“哪个窗口当前可交互”

它不负责渲染。

### WindowHost

`WindowHost` 挂在 workbench 根部，负责：

- 读取 `WindowManager` 的窗口列表
- 桌面端渲染所有打开中的窗口
- 移动端只渲染当前栈顶窗口
- 渲染遮罩与全局层级容器

它是窗口系统和 `WorkbenchShell` 的连接点。

### WindowSurface

`WindowSurface` 是单个窗口外壳，负责：

- 标题栏
- 关闭按钮
- 大小与安全区约束
- 桌面端拖拽
- 点击置顶
- 父窗口失活时的降亮度/降对比度样式
- 父窗口内容区交互屏蔽

它不理解字段、按钮、自定义块语义。

### DialogRenderer

`DialogRenderer` 根据窗口定义中的 `schema`、`actions`、`blocks` 渲染内容，并管理：

- 表单初值
- 字段更新
- 校验错误
- 提交中状态
- 按钮触发
- 结果返回

### 兼容包装层

现有 `WorkbenchDialog` 不再作为长期核心，但第一阶段保留为兼容包装层：

- 对现有调用方维持短期兼容
- 内部逐步改为走 `WindowSurface`
- 新功能不再继续基于它扩展

## 核心类型

### 窗口大小

窗口大小统一使用 `size`，不再使用 `widthClass` / `variant` 这类分散 API。

```ts
type WindowSize = "auto" | "sm" | "md" | "lg" | "xl" | "full";
```

语义如下：

- `auto`
  - 由内容支撑尺寸
  - 但仍受桌面最大宽高和安全区限制
- `sm` / `md` / `lg` / `xl`
  - 桌面端预设宽度档位
  - 只用于标准对话框，不开放任意宽度覆盖
- `full`
  - 填满安全区内可用空间
  - 适合图片预览、复杂编辑器和移动端全屏窗口

不支持：

- 任意像素宽度
- 任意百分比宽度
- 调用方直接传 `class` 拼尺寸语义

### 窗口定义

```ts
type WindowKind = "dialog" | "panel" | "child-dialog";

type WindowDefinition<TValues, TResult> = {
  id?: string;
  kind: WindowKind;
  title: string;
  description?: string;
  size: WindowSize;

  schema?: DialogSchema<TValues>;
  blocks?: DialogBlock<TValues>[];
  actions?: DialogAction<TValues, TResult>[];

  parentId?: string;
  modal?: boolean;
  movable?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
};
```

约束如下：

- `kind` 决定窗口在桌面和移动端的管理语义
- `schema`、`blocks`、`actions` 可以组合使用，不要求每个窗口都是纯表单
- `parentId` 存在时，该窗口视为父窗口的子窗口
- `movable` 只在桌面端生效
- `modal` 控制是否显示背景遮罩与是否阻止工作台其他区域交互

### 打开结果

统一用 Promise 返回窗口结果。

```ts
type WindowResult<TResult, TValues> =
  | { reason: "action"; actionId: string; values: TValues; result?: TResult }
  | { reason: "close"; values: TValues }
  | { reason: "dismiss"; values: TValues };
```

含义如下：

- `action`
  - 用户点击某个动作按钮
  - `values` 为当前完整表单值
  - `result` 为按钮回调返回值
- `close`
  - 用户通过显式关闭入口关闭窗口
  - 例如标题栏关闭按钮
- `dismiss`
  - 用户通过背景点击、`Escape`、系统返回等方式取消

设计要求：

- 所有结果路径都必须带完整 `values`
- 不能只在“提交按钮”路径上返回表单值

### 字段 DSL

前端独立定义 `DialogSchema`，但字段风格参考后端 schema 的元数据表达。

```ts
type DialogSchema<TValues> = {
  fields: DialogField<TValues>[];
};
```

第一阶段支持以下字段族：

- `string`
- `textarea`
- `number`
- `boolean`
- `enum`
- `group`
- `custom`

说明：

- `group` 用于表达结构化字段分组，不要求和后端 `object` 语义完全一致
- `custom` 用于接入前端自定义渲染，不让 DSL 被纯表单语义绑死

### 自定义内容块

除字段外，窗口还可以声明独立内容块：

```ts
type DialogBlock<TValues> =
  | { kind: "text"; content: string }
  | { kind: "separator" }
  | { kind: "component"; component: Component; props?: Record<string, unknown> };
```

这允许：

- 确认框插入说明文本
- 图片预览插入自定义图片组件
- 面板型窗口插入复杂业务组件

### 按钮动作

```ts
type DialogAction<TValues, TResult> = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  closeAfterResolve?: boolean;
  run?: (context: {
    values: TValues;
    windowId: string;
  }) => Promise<TResult> | TResult;
};
```

约束如下：

- 每个动作拿到的都是当前完整表单值
- `run` 可选，允许存在纯关闭型按钮
- `closeAfterResolve` 控制动作完成后是否自动关闭窗口
- 动作执行期间由 `DialogRenderer` 管理 loading / disable 状态

## 桌面与移动端行为

### 桌面端

桌面端窗口系统行为如下：

- 多窗口可同时存在
- 点击窗口可将其置顶
- 仅允许通过标题栏拖动
- 普通窗口和面板窗口都可以配置为可拖动
- 子窗口永远高于父窗口
- 任意父窗口及其祖先窗口都不能越过自己的任一后代窗口

当父窗口存在子窗口时：

- 父窗口视觉上降亮度/对比度
- 父窗口内容区不可交互
- 但父窗口仍允许通过标题栏拖动

这意味着“父窗口失活”不是“完全冻结”，而是“只保留移动能力，不保留内容操作能力”。

进一步约束：

- 拖动父窗口只改变位置，不改变它相对其后代窗口的层级下界
- 点击父窗口不会把它提升到子窗口之上
- 若存在祖先链 `A -> B -> C`，则必须始终满足 `C` 在最上，`B` 不可高于 `C`，`A` 不可高于 `B` 和 `C`

### 移动端

移动端窗口系统行为如下：

- 不允许拖动
- 不允许通过点击改窗口顺序
- 只显示当前打开栈的栈顶窗口
- 子窗口打开后只显示子窗口
- 关闭栈顶后回到上一个窗口

移动端下：

- `full` 填满安全区内空间
- 其余尺寸使用统一弹窗容器样式
- 不保留桌面端多窗口并排可见能力

## 与 WorkbenchShell 的集成

统一窗口系统是 workbench 包的一部分，但不属于 section 区域 contract。

正确的集成方式是：

- `WorkbenchShell` 内部挂载唯一 `WindowHost`
- 业务组件通过 `useWorkbenchWindows()` 打开窗口
- 页面和 section 不再直接 `teleport` 到 `body`

这意味着：

- 窗口是全局 workbench 能力
- 不是 `listPane` / `mainPane` / `topbar` 这类区域贡献的一部分

## 与后端 schema 的关系

### 不直接复用运行时

不直接依赖 `src/data/schema` 的默认值生成、校验执行和数据解析运行时。

理由如下：

- 前端窗口动作与后端数据解析职责不同
- 前后端生命周期不同
- 直接复用会把 UI 需求反向塞进后端 schema

### 提供可选适配器

允许在前端提供受限适配：

```ts
function schemaMetaToDialogFields(meta: SchemaMeta): DialogField<unknown>[]
```

适配范围只覆盖适合表单渲染的子集，例如：

- 文本
- 数字
- 布尔
- 枚举
- 基础对象分组

不覆盖：

- 后端专属文件语义
- 复杂判别联合
- 任意 record 映射
- 与 UI 不稳定耦合的后端约束

## 迁移策略

### 第一阶段：窗口宿主与层级能力

先实现：

- `WindowManager`
- `WindowHost`
- `WindowSurface`
- 桌面/移动端层级行为
- 父子窗口失活规则

此阶段先解决“统一栈与行为”，不急于一次迁完所有业务弹窗。

### 第二阶段：DSL 与渲染器

再实现：

- `DialogSchema`
- `DialogRenderer`
- `DialogAction`
- `DialogBlock`
- Promise 风格结果返回

此阶段建立统一窗口定义方式。

### 第三阶段：迁移现有弹窗

优先迁移：

1. `WorkbenchDialog`
2. `CreateSessionDialog`
3. `ImagePreviewDialog`
4. `Sessions` 中的会话操作弹窗

迁移顺序这样安排的原因是：

- 先统一低层壳与栈规则
- 再统一声明式 DSL
- 最后迁业务调用方，减少返工

## 对当前代码的影响

预计会引入新的 workbench 文件边界：

- `webui/src/components/workbench/windows/WindowHost.vue`
- `webui/src/components/workbench/windows/WindowSurface.vue`
- `webui/src/components/workbench/windows/DialogRenderer.vue`
- `webui/src/composables/workbench/useWorkbenchWindows.ts`
- `webui/src/composables/workbench/windowManager.ts`
- `webui/src/components/common/WorkbenchDialog.vue`

其中：

- `WorkbenchDialog.vue` 会被降级为兼容包装层
- 新窗口系统的正式入口在 `workbench/windows/*`

## 测试策略

至少覆盖以下行为：

- 打开多个桌面窗口时的层级顺序
- 点击窗口置顶
- 子窗口打开后父窗口降亮度/对比度且内容不可交互
- 父窗口在有子窗口时仍可拖动
- 移动端只显示栈顶窗口
- 动作按钮回调拿到完整表单值
- 关闭与取消路径也返回完整表单值
- `SchemaMeta` 适配器只转换受支持字段

测试层次建议：

- 纯状态逻辑测试：
  - `WindowManager`
- 组件结构与行为测试：
  - `WindowHost`
  - `WindowSurface`
  - `DialogRenderer`
- source test：
  - 防止新业务组件继续直接 `teleport` 到 `body`

## 风险与取舍

### 风险 1：DSL 过度设计

如果第一版试图覆盖过多字段类型、布局能力和任意尺寸，会把统一窗口系统重新做成低约束脚手架。

取舍：

- 第一版只支持必要字段族
- 通过 `custom` 字段与 `component` block 兜住复杂场景

### 风险 2：兼容包装层长期存在

如果 `WorkbenchDialog` 长期既保留旧 props 又承接新行为，最终会形成双重 API。

取舍：

- 兼容层只作为迁移过渡
- 新功能禁止继续基于旧 props 扩展

### 风险 3：把 section layout contract 和窗口系统混在一起

窗口系统虽然属于 workbench 包，但它不是页面区域贡献模型的一部分。

取舍：

- `WindowHost` 固定挂在 `WorkbenchShell`
- 不把窗口内容注册进 `WorkbenchSection.regions`

## 结论

任务 1 不应理解为“把 `WorkbenchDialog` 做得更大”，而应理解为：

- 建立统一窗口栈
- 建立统一窗口定义 DSL
- 把现有所有弹窗/面板/预览都收敛到这一个系统里

设计上采用“前端独立窗口 DSL + 可选后端 schema 适配”的方向，可以同时满足：

- 完整类型标注
- 统一行为
- workbench 级复用
- 后续抽成共享包时的清晰边界

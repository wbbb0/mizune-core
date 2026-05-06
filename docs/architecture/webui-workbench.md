# WebUI Workbench 架构

本文档整理当前 WebUI 工作台的长期结构约定。当前前端共享能力已经从 `webui/src` 业务源码中拆到 repo 内源码包：

- `packages/vue-workbench`：工作台外壳、导航、pane、菜单、toast、窗口、基础 primitives 与主题基础样式。
- `packages/vue-resource-editor`：schema 驱动资源编辑器的类型、字段渲染、草稿状态、资源编辑状态工厂与 editor client 契约。
- `packages/vue-file-workspace`：通用本地文件树、文件预览 client 契约与文件类型。
- `webui/src`：llm-onebot 的业务 section、API adapter、路由、store、主题 token 值与具体资源接线。

这些包当前作为源码包由 WebUI 通过 Vite / TypeScript alias 引用；后续需要跨仓库复用时，可以把 `packages/*` 发布为 npm 包。项目模板只应包含示例路由、section registry、theme token 和 API adapter 示例，不应被多个项目运行时引用。

## Workbench 外壳与 Section Contract

WebUI 采用统一 workbench 外壳，而不是让每个页面各自拼整套布局。

当前主结构：

- 项目侧 `AppWorkbenchRoot`
  - 根据 Vue Router meta 选择当前 view。
  - 传入 view、导航项、chrome、状态栏项、移动端状态和导航回调。
- `WorkbenchRoot`
  - 创建并提供 workbench controller。
  - 挂载 `WorkbenchShell`、`MenuHost`、`ToastViewport` 与 `WindowHost`。
- 项目侧 `sections/registry`
  - 维护本项目 section 注册表，不属于 workbench 包。
- `workbenchRuntime`
  - 管理移动端区域栈、当前激活 workbench、键盘避让边界和桌面 pane 尺寸。

当前 view 至少声明：

- `id`
- `title`
- `areas.mainArea`
- 可选 `areas.primarySidebar`
- 可选 `areas.secondarySidebar`
- 可选 `areas.bottomPanel`
- 可选 `areas.mobileHeader`
- 可选 `layout.mobile.rootArea`
- 可选 `layout.desktop.primarySidebar / secondarySidebar / bottomPanel`

这样 route 只负责选择 view，布局行为由 workbench 统一承担。

相关实现入口：

- `webui/src/sections/AppWorkbenchRoot.vue`
- `webui/src/sections/registry.ts`
- `webui/src/sections/useWorkbenchViewRegistry.ts`
- `packages/vue-workbench/src/WorkbenchRoot.vue`
- `packages/vue-workbench/src/WorkbenchShell.vue`
- `packages/vue-workbench/src/runtime/workbenchRuntime.ts`
- `packages/vue-workbench/src/types.ts`

## 桌面端与移动端布局

桌面端与移动端共享同一份 view contract，但由不同外壳负责呈现。

桌面端结构：

- `TopBar`
- `WorkbenchActivityBar`
- `primarySidebar`
- `mainArea`
- 可选 `secondarySidebar`
- 可选 `bottomPanel`
- `StatusBar`

移动端结构：

- 区域切换由 `workbenchRuntime` 的移动端区域栈控制。
- `layout.mobile.rootArea` 决定移动端根区域，默认回退到 `mainArea`。
- 非根区域作为覆盖层显示。
- 浏览器返回在移动端优先弹出覆盖层，再退回真实路由历史。
- 导航项由项目侧传入，workbench 包不直接 import Vue Router、业务 store 或业务 section 列表。

相关实现入口：

- `packages/vue-workbench/src/DesktopWorkbench.vue`
- `packages/vue-workbench/src/MobileWorkbench.vue`
- `packages/vue-workbench/src/runtime/workbenchRuntime.ts`

## 桌面 Pane 尺寸

桌面端 pane 尺寸属于 workbench runtime 能力，不应由各 section 自己维护局部状态。

当前约定：

- `layout.desktop.*` 声明各 pane 的默认值和尺寸约束。
- pane 实际尺寸由 `workbenchRuntime` 统一维护。
- 用户拖拽后的 pane 尺寸按全局 pane id 持久化。
- section 切换时，runtime 会用当前 view 的 min/max 约束重新 clamp。
- 双击分隔条重置为当前 view 的默认尺寸，并写回全局尺寸。

## 全局 Chrome 与菜单系统

顶部菜单、底部状态栏和全局菜单属于 workbench 外壳能力，而不是某个 section 自己实现的局部浮层。

当前抽象分为两层：

- chrome 描述层
  - `WorkbenchTopbarMenu`
  - `WorkbenchStatusbarItem`
- 菜单运行时
  - `MenuHost`
  - `useMenuRuntime`
  - `useMenuTrigger`

当前约定：

- 顶部菜单通过结构化 `MenuNode[]` 描述。
- 状态栏项以组件形式声明，必要时可转换成菜单节点。
- 移动端通过统一工作台菜单入口承接顶部菜单和状态栏内容。
- 菜单系统统一处理层级、定位、键盘导航、子菜单与点击外部关闭。
- 页面导航菜单由项目侧传入的导航项生成，workbench 包不依赖 Vue Router。

相关实现入口：

- `packages/vue-workbench/src/chrome.ts`
- `packages/vue-workbench/src/navigation.ts`
- `packages/vue-workbench/src/TopBar.vue`
- `packages/vue-workbench/src/StatusBar.vue`
- `packages/vue-workbench/src/menu/MenuHost.vue`
- `packages/vue-workbench/src/menu/types.ts`
- `webui/src/composables/useAppWorkbenchChrome.ts`

## Toast / Notification

Toast 属于 workbench overlay 能力，由 `WorkbenchRoot` 挂载，而不是由 `App.vue` 全局挂载。

当前约定：

- 业务代码通过 `useWorkbenchToasts` 发送 toast。
- `ToastViewport` 由 `WorkbenchRoot` 统一渲染。
- toast 样式依赖 workbench 主题 token，不直接依赖业务页面结构。

相关实现入口：

- `packages/vue-workbench/src/toasts/useWorkbenchToasts.ts`
- `packages/vue-workbench/src/toasts/ToastViewport.vue`

## 统一窗口系统

WebUI 的弹窗能力收敛到统一窗口系统，而不是让各组件直接 `teleport` 到 `body` 自己管理状态。

窗口系统分为两层：

- 窗口管理层
  - `createWindowManager`
  - `useWorkbenchWindows`
  - 负责窗口栈、焦点、父子关系、拖拽位置和桌面/移动端可见集合。
- 窗口渲染层
  - `WindowHost`
  - `WindowSurface`
  - `DialogRenderer`
  - 负责统一渲染窗口外壳、字段、动作按钮和自定义块。

当前约定：

- `WorkbenchRoot` 只挂一个 `WindowHost`。
- 桌面端允许多窗口、置顶与父子层级。
- 移动端只暴露栈顶窗口。
- 新弹窗应优先走统一窗口定义，不新增局部浮层体系。

相关实现入口：

- `packages/vue-workbench/src/windows/useWorkbenchWindows.ts`
- `packages/vue-workbench/src/windows/windowManager.ts`
- `packages/vue-workbench/src/windows/WindowHost.vue`
- `packages/vue-workbench/src/windows/WindowSurface.vue`
- `packages/vue-workbench/src/windows/DialogRenderer.vue`
- `packages/vue-workbench/src/windows/types.ts`

## Resource Editor

配置编辑器和数据编辑器共用 `vue-resource-editor` 的通用能力，业务项目只提供 editor client 和具体 section 接线。

共享包负责：

- `EditorResourceSummary`、`EditorModel`、`SchemaMeta`、`UiNode` 等前端协议类型。
- `SchemaNode` / `SchemaField` 的 schema 驱动字段渲染。
- `useEditorDraftState` 的草稿、引用值、有效值和 dirty 判断。
- `createResourceEditorState` 的资源列表、选择、加载、验证、保存和重新加载流程。
- `ResourceEditorClient` 契约。

业务项目负责：

- `webui/src/api/editor.ts` 把内部 API 适配成 `ResourceEditorClient`。
- `webui/src/main.ts` 通过 `configureResourceEditorClient(editorApi)` 提供动态选项 client。
- `webui/src/composables/sections/useConfigSection.ts` 设置 domain、toast、移动端导航等项目侧行为。
- `src/internalApi/application/editorService.ts` 注册 llm-onebot 自己的配置与数据资源。

具体资源名称、配置层级、数据文件路径和 schema 注册属于 llm-onebot 业务，不进入共享包。

## File Workspace

`vue-file-workspace` 只抽通用文件浏览能力，不包含聊天文件、内容安全、caption 等 llm-onebot 语义。

共享包负责：

- `LocalFileItem`、`LocalFileListResult`、`LocalFilePreview`、`FileWorkspaceClient` 类型。
- `FileTree` 目录树组件。

业务项目负责：

- `webui/src/api/workspace.ts` 把 `/api/local-files/*` 适配成 `FileWorkspaceClient`。
- `webui/src/composables/sections/useWorkspaceSection.ts` 管理本项目的本地文件、聊天文件和预览状态。
- `webui/src/sections/workspace/*` 渲染 llm-onebot 的文件工作区。

## 主题契约

Workbench framework 依赖一组稳定主题 token，而不是具体业务页面样式。

当前必须提供的 token 类别：

- surface：`bg-surface-app`、`bg-surface-sidebar`、`bg-surface-panel`
- border：`border-border-default`
- text：`text-text-primary`、`text-text-secondary`、`text-text-muted`
- accent / state：`text-accent`、`bg-accent`、`text-danger`、`bg-surface-danger`、`text-success`、`bg-surface-success`
- safe area：`pt-safe`、`pl-safe`、`pr-safe`、`pb-safe-offset-*`
- workbench size：`--activity-bar-width`

当前 token 值在 `webui/src/style/theme.css` 中定义；workbench 基础样式从 `@llm-onebot/vue-workbench/style.css` 引入。抽成独立模板项目时，应把这些 token 作为模板主题契约保留，业务项目只覆盖 token 值，不改 workbench 组件结构。

## 后续扩展约束

后续若继续扩展 workbench，应优先遵守以下边界：

- 页面不重新拥有整套布局。
- 顶部工具栏、状态栏、菜单和窗口都走 workbench 级共享能力。
- 移动端退化策略由 workbench 控制，而不是由 section 各自发明。
- 新的弹窗 / 工具面板优先接入统一窗口系统。
- 能通过 `client` / adapter 注入的能力可以进入共享包。
- 必须知道 llm-onebot 资源名称、路径、业务字段或运行时服务的逻辑留在业务项目。

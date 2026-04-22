# WebUI Workbench 架构

本文档整理当前 WebUI 工作台的长期结构约定，覆盖 section workbench、全局 chrome / 菜单，以及统一窗口系统三部分。

## Workbench 外壳与 Section Contract

WebUI 当前采用统一的 workbench 外壳，而不是让每个页面各自拼整套布局。

当前主结构：

- `SectionHost`
  - 根据路由选择 section，并把 section 描述交给 workbench
- `WorkbenchShell`
  - 统一挂载桌面端 / 移动端工作台外壳
  - 同时挂载全局 `MenuHost` 与 `WindowHost`
- `useWorkbenchRegistry`
  - 维护 section 注册表
- `useWorkbenchRuntime`
  - 管理移动端 `list/main` 等工作台级状态

当前 section 至少声明：

- `title`
- `regions.listPane`
- `regions.mainPane`
- 可选的 `regions.mobileHeader`
- `layout.mobileMainFlow`

这样 page / route 只负责选择 section，布局行为由 workbench 统一承担。

相关实现入口：

- `webui/src/components/workbench/SectionHost.vue`
- `webui/src/components/workbench/WorkbenchShell.vue`
- `webui/src/components/workbench/types.ts`
- `webui/src/composables/workbench/useWorkbenchRegistry.ts`
- `webui/src/composables/workbench/useWorkbenchRuntime.ts`
- `webui/src/sections/registry.ts`

## 桌面端与移动端布局

桌面端与移动端共享同一份 section contract，但由不同外壳负责呈现。

桌面端结构：

- `TopBar`
- `ActivityBar`
- 左侧 `listPane`
- 右侧 `mainPane`
- `StatusBar`

移动端结构：

- list / main 两屏切换由 `useWorkbenchRuntime` 控制
- list 屏显示 section 列表区域和工作台菜单入口
- main 屏显示 section 主内容与移动端头部
- 移动端不常驻完整桌面 chrome，而是把全局操作折叠进工作台菜单

相关实现入口：

- `webui/src/components/workbench/DesktopWorkbench.vue`
- `webui/src/components/workbench/MobileWorkbench.vue`
- `webui/src/composables/workbench/useWorkbenchRuntime.ts`

## 全局 Chrome 与菜单系统

顶部工具栏、底部状态栏和全局菜单属于 workbench 外壳能力，而不是某个 section 自己实现的局部浮层。

当前抽象分为两层：

- chrome 描述层
  - `WorkbenchTopbarMenu`
  - `WorkbenchStatusbarItem`
- 菜单运行时
  - `MenuHost`
  - `useMenuRuntime`
  - `useMenuTrigger`

当前约定：

- 顶部菜单通过结构化 `MenuNode[]` 描述
- 状态栏项以组件形式声明，必要时可转换成菜单节点
- 移动端通过统一的工作台菜单入口承接顶部菜单和状态栏内容
- 菜单系统统一处理层级、定位、键盘导航、子菜单与点击外部关闭

相关实现入口：

- `webui/src/components/workbench/chrome.ts`
- `webui/src/composables/workbench/useWorkbenchChrome.ts`
- `webui/src/components/workbench/TopBar.vue`
- `webui/src/components/workbench/StatusBar.vue`
- `webui/src/components/workbench/menu/MenuHost.vue`
- `webui/src/components/workbench/menu/types.ts`
- `webui/src/composables/workbench/menu/useMenuRuntime.ts`
- `webui/src/composables/workbench/menu/useMenuTrigger.ts`

## 统一窗口系统

WebUI 当前的弹窗能力已经收敛到统一窗口系统，而不是继续让各组件直接 `teleport` 到 `body` 自己管理状态。

窗口系统分为两层：

- 窗口管理层
  - `createWindowManager`
  - `useWorkbenchWindows`
  - 负责窗口栈、焦点、父子关系、拖拽位置和桌面/移动端可见集合
- 窗口渲染层
  - `WindowHost`
  - `WindowSurface`
  - `DialogRenderer`
  - 负责统一渲染窗口外壳、字段、动作按钮和自定义块

当前约定：

- `WorkbenchShell` 只挂一个 `WindowHost`
- 桌面端允许多窗口、置顶与父子层级
- 移动端只暴露栈顶窗口
- 兼容层可以存在，但新弹窗应优先走统一窗口定义

相关实现入口：

- `webui/src/composables/workbench/windowManager.ts`
- `webui/src/composables/workbench/useWorkbenchWindows.ts`
- `webui/src/components/workbench/windows/WindowHost.vue`
- `webui/src/components/workbench/windows/WindowSurface.vue`
- `webui/src/components/workbench/windows/DialogRenderer.vue`
- `webui/src/components/workbench/windows/types.ts`

## 窗口 DSL 与后端 Schema 的关系

窗口系统参考后端 schema 的元数据风格，但不直接复用后端运行时实现。

当前边界：

- 后端 schema 仍负责数据模型、校验、默认值与编辑器元数据导出
- 前端窗口系统负责字段布局、按钮动作、窗口结果和自定义交互块
- 若需要复用后端元数据，可通过受限适配器把 `SchemaMeta` 转为窗口字段定义

相关实现入口：

- `webui/src/components/workbench/windows/dialogSchemaAdapter.ts`
- `src/internalApi/application/editorService.ts`

## 后续扩展约束

后续若继续扩展 workbench，应优先遵守以下边界：

- 页面不重新拥有整套布局
- 顶部工具栏、状态栏、菜单和窗口都走 workbench 级共享能力
- 移动端退化策略由 workbench 控制，而不是由 section 各自发明
- 新的弹窗 / 工具面板优先接入统一窗口系统，而不是再增加新的局部浮层体系

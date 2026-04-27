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
- `workbenchRuntime`
  - 管理移动端 `list/main`、当前激活 workbench、键盘避让边界和桌面 pane 尺寸等工作台级运行状态

当前 section 至少声明：

- `title`
- `regions.listPane`
- `regions.mainPane`
- 可选的 `regions.mobileHeader`
- `layout.mobile.mainFlow`
- 可选的 `layout.desktop.listPane`

这样 page / route 只负责选择 section，布局行为由 workbench 统一承担。

相关实现入口：

- `webui/src/components/workbench/SectionHost.vue`
- `webui/src/components/workbench/WorkbenchShell.vue`
- `webui/src/components/workbench/runtime/workbenchRuntime.ts`
- `webui/src/components/workbench/types.ts`
- `webui/src/composables/workbench/useWorkbenchRegistry.ts`
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

- list / main 两屏切换由 `workbenchRuntime` 控制
- list 屏显示 section 列表区域和工作台菜单入口
- main 屏显示 section 主内容与移动端头部
- 移动端不常驻完整桌面 chrome，而是把全局操作折叠进工作台菜单
- main 屏作为覆盖层从右侧进入，list 屏保持挂载在下方
- 浏览器返回在移动端优先弹出 main 覆盖层，再退回真实路由历史

相关实现入口：

- `webui/src/components/workbench/DesktopWorkbench.vue`
- `webui/src/components/workbench/MobileWorkbench.vue`
- `webui/src/components/workbench/runtime/workbenchRuntime.ts`

## 桌面 Pane 尺寸

桌面端 pane 尺寸属于 workbench runtime 能力，不应由各 section 自己维护局部状态。

当前约定：

- `layout.desktop.listPane` 只声明约束和默认值
- list pane 的实际宽度由 `workbenchRuntime` 统一维护
- 用户拖拽后的 list pane 宽度以一份全局值持久化，而不是按 section 分开保存
- section 切换时，runtime 会用当前 section 的 `minWidthPx` / `maxWidthPx` 对全局宽度重新 clamp
- 双击分隔条重置为当前 section 的默认宽度，并写回全局宽度
- 后续若扩展到更多 VS Code 风格 pane，可沿用“全局实际尺寸 + section 约束”的模型，再把 pane id 纳入 runtime 的统一尺寸 registry

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

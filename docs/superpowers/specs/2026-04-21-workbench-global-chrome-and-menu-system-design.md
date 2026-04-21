# Workbench Global Chrome And Menu System Design

## 背景

Phase 1 已经把 WebUI 页面从“每个 page 自己包一层完整布局”收敛到统一的 `WorkbenchShell + SectionHost + Registry` 结构，但顶部工具栏和底部状态栏仍未成为明确的工作台级能力。

当前还存在两个问题：

- 桌面端缺少固定的全局 `TopBar` / `StatusBar`
- 移动端没有一套统一的非占位式全局菜单系统，无法自然承接：
  - 顶部工具栏内容
  - 底部状态栏内容
  - 右键菜单 / 长按菜单
  - 后续的全局操作入口

本设计的目标，是把这两类能力统一收口到工作台外框层，而不是继续作为 section 级页面内容实现。

## 目标

- 在 `WorkbenchShell` 中引入固定的全局 `TopBar` 和 `StatusBar`
- 桌面端始终显示完整 `TopBar` / `StatusBar`
- 顶部安全区不再由 shell 根节点承担，而是移动到 `TopBar`
- 移动端不常驻显示完整顶栏/底栏内容，而是通过一个固定入口打开全局菜单
- 引入统一的 `MenuHost`，同时服务：
  - 移动端工具栏菜单
  - 移动端状态栏菜单
  - 右键菜单 / 长按菜单
  - 多层子菜单
- 菜单项同时支持结构化 schema 与受控的自定义组件项

## 非目标

- 这轮不实现多窗口/可拖拽弹窗系统
- 这轮不实现页面级工具栏或页面级状态栏注入
- 这轮不实现可拖拽、可停靠、可自由重排的面板系统
- 这轮不实现工作台菜单的个性化配置或用户自定义排序
- 这轮不实现命令面板或全局 action 总线

## 设计原则

### 工具栏和状态栏属于工作台外框

`TopBar` 和 `StatusBar` 属于全局一致的应用外框，不属于 section 内容。

因此：

- 不通过 `section.regions.topbar/statusbar` 驱动实际渲染
- 不允许各页面单独决定是否显示它们
- 它们由 `WorkbenchShell` 固定承载

页面自己的 header 仍留在各自的 `listPane` / `mainPane` 内部。

### 桌面端显示完整内容，移动端退化成菜单

桌面端需要稳定、持续可见的工具栏和状态栏；移动端则应尽量不占据页面常驻空间。

因此：

- 桌面端直接显示完整 `TopBar` / `StatusBar`
- 移动端只显示一个固定入口按钮
- 按钮打开一级全局菜单，再通过两个子菜单分别进入：
  - `工具栏`
  - `状态栏`

### 菜单系统统一，而不是为每种入口单独做浮层

移动端工具栏菜单、移动端状态栏菜单、右键菜单和长按菜单，本质上都属于同一类“锚点弹出的层叠菜单”。

因此：

- 使用统一的 `MenuHost`
- 用统一的层叠、定位、关闭、子菜单规则
- 不再为 `TopBarBubble`、`StatusBarBubble`、`ContextMenu` 分别做三套系统

### 允许结构化菜单项，也允许受控组件项

普通菜单默认使用结构化 schema；需要承载小面板式内容时，允许使用 `component` 类型菜单项。

约束如下：

- `component` 是叶子节点，不允许带 `children`
- 只有 `submenu` 允许带 `children`
- 菜单定位、层叠、关闭行为仍由菜单系统统一控制

## 目标结构

## 桌面端结构

桌面端工作台编排统一为：

1. `TopBar`
2. `WorkbenchBody`
3. `StatusBar`
4. `MenuHost`

其中：

- `WorkbenchBody` 继续承载：
  - `ActivityBar`
  - `listPane`
  - `mainPane`
  - 未来的 `auxPane`
- `TopBar` 和 `StatusBar` 为固定全局区域
- `MenuHost` 作为全局浮层宿主，不占布局流

伪代码：

```vue
<WorkbenchShell>
  <TopBar />
  <WorkbenchBody />
  <StatusBar />
  <MenuHost />
</WorkbenchShell>
```

## 移动端结构

移动端不显示完整 `TopBar` / `StatusBar`，只保留一个固定入口按钮。

工作台编排统一为：

1. 页面主体继续走 `list -> main` 双屏流
2. 导航图标区最右侧增加一个固定按钮
3. 点击该按钮打开一级工作台菜单
4. 一级菜单中有两个 `submenu`：
  - `工具栏`
  - `状态栏`
5. 分别展开对应菜单内容

伪代码：

```ts
const mobileWorkbenchMenu: MenuNode[] = [
  {
    kind: "submenu",
    id: "mobile-topbar",
    label: "工具栏",
    children: topBarMenuNodes
  },
  {
    kind: "submenu",
    id: "mobile-statusbar",
    label: "状态栏",
    children: statusBarMenuNodes
  }
]
```

这样移动端始终只有一个固定入口，而不是两个独立按钮。

## TopBar 设计

`TopBar` 是桌面端固定显示的全局工具栏。

第一版职责：

- 承担顶部安全区
- 提供类似 VSCode 的菜单入口区
- 先只放一个占位菜单项
- 点击菜单项后通过 `MenuHost` 打开一级菜单

明确约束：

- `TopBar` 不显示 section 级工具栏内容
- 页面自己的主区 header 不上提到 `TopBar`

推荐结构：

- 左侧：全局菜单入口区
- 中间：保留空位或后续命令入口区
- 右侧：保留空位或少量全局操作区

## StatusBar 设计

`StatusBar` 是桌面端固定显示的全局状态栏。

第一版职责：

- 承担底部安全区
- 平铺显示全局一致的状态组件
- 不显示页面级局部状态

推荐第一版状态组件：

- 连接状态
- 当前实例 / 环境摘要

这些状态组件在桌面端直接显示，在移动端则作为 `component` 菜单项进入状态栏菜单。

## MenuHost 设计

`MenuHost` 是统一的全局菜单宿主，负责：

- 锚点定位
- 层叠子菜单
- 关闭规则
- 键盘导航
- 菜单栈管理

承接的菜单来源包括：

- 移动端工作台入口菜单
- 顶栏菜单
- 状态栏菜单
- 右键菜单
- 长按菜单

## 菜单节点模型

菜单节点支持以下类型：

- `action`
- `toggle`
- `radio`
- `submenu`
- `group`
- `separator`
- `component`

推荐接口：

```ts
type MenuNode =
  | {
      kind: "action"
      id: string
      label: string
      icon?: Component
      shortcut?: string
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | {
      kind: "toggle"
      id: string
      label: string
      checked: boolean
      disabled?: boolean
      onToggle: (next: boolean) => void
    }
  | {
      kind: "radio"
      id: string
      label: string
      checked: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | {
      kind: "submenu"
      id: string
      label: string
      icon?: Component
      disabled?: boolean
      children: MenuNode[]
    }
  | {
      kind: "group"
      id: string
      label?: string
      children: MenuNode[]
    }
  | {
      kind: "separator"
      id: string
    }
  | {
      kind: "component"
      id: string
      component: Component
      props?: Record<string, unknown>
      width?: "sm" | "md" | "lg" | "fit"
      closeOnInteract?: boolean
    }
```

关键约束：

- 只有 `submenu` 允许 `children`
- `component` 不允许 `children`
- `component` 用于渲染自定义小面板，而不是重新定义菜单层级

## 菜单上下文

自定义 `component` 菜单项需要与菜单系统协作，因此菜单系统应提供受控上下文，例如：

```ts
type MenuComponentContext = {
  closeSelf: () => void
  closeAll: () => void
  openSubmenu: (anchor: MenuAnchor, items: MenuNode[]) => void
  source: "mobile-workbench" | "topbar" | "statusbar" | "contextmenu"
}
```

这样自定义组件可以：

- 主动关闭自己
- 关闭整组菜单
- 在受控边界内触发下一层菜单

同时不会绕开 `MenuHost` 的统一规则。

## 组件边界

建议新增以下组件：

- `webui/src/components/workbench/TopBar.vue`
- `webui/src/components/workbench/StatusBar.vue`
- `webui/src/components/workbench/DesktopWorkbench.vue`
- `webui/src/components/workbench/MobileWorkbench.vue`
- `webui/src/components/menu/MenuHost.vue`
- `webui/src/components/menu/MenuSurface.vue`
- `webui/src/components/menu/MenuTrigger.vue`

建议新增以下状态栏展示组件：

- `webui/src/components/workbench/status/ConnectionStatusChip.vue`
- `webui/src/components/workbench/status/InstanceStatusChip.vue`

职责划分：

- `TopBar` / `StatusBar` 只负责桌面端完整展示
- 移动端菜单内容由菜单数据源提供，不直接复用桌面完整 DOM
- `MenuHost` 负责所有菜单浮层的渲染与行为

## Runtime 设计

`useWorkbenchRuntime()` 继续只负责工作台主体切换：

- `mobileScreen`
- `showList()`
- `showMain()`

不要把菜单状态继续堆进 `useWorkbenchRuntime()`。

建议新增 `useMenuRuntime()`：

```ts
type MenuRuntime = {
  openMenu: (args: OpenMenuArgs) => void
  openSubmenu: (args: OpenMenuArgs) => void
  closeMenu: (id: string) => void
  closeAllMenus: () => void
}
```

移动端固定入口、顶栏菜单入口、右键菜单都通过这套 runtime 打开菜单。

## 与 Section Contract 的关系

Phase 1 中 `WorkbenchSection` 已预留 `topbar/statusbar/mobileTopMenu/mobileBottomMenu` 等字段。

任务 2 的建议是：

- 保留这些字段，暂不删除
- 但 `WorkbenchShell` 的实际全局 `TopBar` / `StatusBar` 不依赖 section 提供内容
- 它们在当前阶段视为“未启用保留位”

原因：

- 避免当前再改一轮 contract
- 同时保持实现边界清楚，不把全局栏重新做成页面级能力

## 安全区处理

当前顶部安全区位于工作台根节点。

任务 2 之后应调整为：

- `TopBar` 自己承担顶部安全区
- `StatusBar` 承担底部安全区
- `WorkbenchBody` 只承载真实内容区

这样职责更明确，布局计算也更稳定。

## 第一版范围

第一版建议只做以下内容：

1. 桌面端固定 `TopBar`
- 只包含一个占位菜单入口

2. 桌面端固定 `StatusBar`
- 先展示 1 到 2 个状态组件

3. 移动端一个固定入口按钮
- 位于导航图标区最右侧
- 打开一级工作台菜单

4. `MenuHost`
- 支持一级菜单
- 支持子菜单
- 支持 `component` 菜单项

5. 顶部安全区迁移
- 从 `WorkbenchShell` 根节点迁移到 `TopBar`

## 明确延期的内容

以下能力不属于本轮：

- 页面级工具栏注入
- 页面级状态栏注入
- 多窗口/拖拽弹窗系统
- 菜单与窗口系统合并
- 用户自定义移动端入口排序
- 高阶全局命令面板

## 实施顺序

推荐按以下顺序推进：

1. 拆出 `DesktopWorkbench` / `MobileWorkbench`
- 让桌面和移动布局分离，避免单组件内条件分支膨胀

2. 落 `TopBar` / `StatusBar`
- 先把桌面固定栏立住
- 同时迁移安全区职责

3. 落 `MenuHost` 基础能力
- 先支持一级菜单、子菜单和 `component` 叶子节点

4. 接入移动端固定入口
- 改成一个按钮打开一级工作台菜单

5. 补测试
- 验证全局栏是 shell 固定区域
- 验证移动端入口是单按钮 + 双子菜单
- 验证 `component` 为叶子节点约束

## 结论

任务 2 的最终方向是：

- 桌面端使用固定的全局 `TopBar + StatusBar`
- 移动端使用一个固定入口按钮打开一级工作台菜单
- 一级菜单通过两个 `submenu` 分别进入工具栏菜单和状态栏菜单
- 右键菜单与这些菜单共用统一的 `MenuHost`
- `component` 菜单项用于承载顶栏/状态栏的小面板内容，但始终是叶子节点

这样可以在不污染页面布局 contract 的前提下，把工作台外框能力与菜单系统一次收口到正确层级。

# WebUI Workbench Layout Extraction Design

## 背景

当前 WebUI 已经具备统一的最外层壳子，但页面结构仍停留在“每个 page 自己包一层完整布局”的阶段：

- `SessionsPage`、`ConfigPage`、`DataPage`、`WorkspacePage`、`SettingsPage` 都各自声明一次 `AppLayout`
- 左侧清单、右侧主区域顶部 header、移动端 header 等结构散落在各页面中
- 移动端的 `list -> main` 切换能力被页面通过 `layoutRef.openDetail()` 直接驱动
- 顶部工具栏、右侧侧栏、底部状态栏等未来工作台区域尚未进入统一模型

这导致当前结构虽然可用，但不适合继续往 VSCode 风格工作台演进，也不利于未来抽成可复用的仓库内共享布局包。

本设计的目标，是把当前 WebUI 收敛到一个明确的 workbench 架构：页面不再拥有整套布局，而是向统一工作台注册各自的区域内容。

## 目标

- 建立唯一的 `WorkbenchShell`，承接工作台级布局与响应式行为
- 建立静态 `WorkbenchRegistry`，让每个 section 注册自己对各区域的内容贡献
- 让 `page` 文件变薄，只负责选择 section，不再直接拼工作台布局
- 把移动端 `list/main` 切换、右侧抽屉、顶部/底部气泡菜单等行为统一收口到 workbench runtime
- 为未来新增顶部工具栏、右侧侧栏、底部状态栏等区域预留稳定 contract
- 让当前仓库的布局边界自然演进到后续可抽成共享包的形态

## 非目标

- 这轮不实现完整的插件式扩展系统
- 这轮不实现可拖拽、可自由停靠的 panel 管理
- 这轮不实现命令面板、全局 action 总线等更高阶工作台能力
- 这轮不强制一次迁完所有现有页面
- 这轮不以 `SessionsPage` 的复杂布局反向定义整个工作台抽象

## 设计原则

### 页面不拥有工作台布局

路由页面仍然存在，用于表达 URL 语义；但页面不再直接声明 `AppLayout`、`side`、`main`、`mobile-header` 等完整布局结构。

页面只负责声明“当前路由对应哪个 section”。

### Section 只声明区域内容

每个功能区不再是“一个拥有完整页面布局的 page”，而是“一个向工作台注册多块区域内容的 section”。

Section 只负责：

- 当前功能区的左侧清单内容
- 主区域内容
- 右侧侧栏内容
- 顶部工具栏内容
- 底部状态栏内容
- 移动端 header 与气泡菜单内容

Section 不负责：

- 整体桌面/移动端编排
- 抽屉/气泡菜单显隐
- 面板切换行为
- 顶级导航结构

### Shell 负责布局行为，Section 负责业务内容

工作台层必须清楚区分两类职责：

- `WorkbenchShell` 负责区域编排、响应式切换、抽屉/气泡菜单显隐、默认区域占位
- Section 负责往各区域填具体业务内容

这样未来新增 footer、toolbar、aux pane 时，不需要修改各页面的布局骨架。

## 目标工作台区域

本项目未来的工作台模型统一包含以下区域：

- `nav`
  - 左侧导航按钮区
- `topbar`
  - 顶部工具栏
- `listPane`
  - 左侧清单区，包含自己的 header
- `mainPane`
  - 中间主页面区域，包含自己的 header
- `auxPane`
  - 右侧侧栏，包含自己的 header
- `statusbar`
  - 底部状态栏
- `mobileHeader`
  - 移动端 detail 区顶部 header 内容
- `mobileTopMenu`
  - 移动端顶部气泡菜单内容
- `mobileBottomMenu`
  - 移动端底部气泡菜单内容

其中：

- `nav` 由工作台自己控制，不由 section 注册
- 其余区域由 section 选择性提供内容

## 桌面与移动端布局行为

### 桌面

桌面端工作台编排统一为：

- 顶部 `topbar`
- 中间四列：
  - `nav`
  - `listPane`
  - `mainPane`
  - `auxPane`
- 底部 `statusbar`

各区域是否显示由 `WorkbenchShell` 根据 section 的默认配置和运行时状态统一决定。

### 移动端

移动端工作台行为统一为：

- `listPane` 与 `mainPane` 共享主屏，通过 `list -> main` 双屏流切换
- `auxPane` 不再占据固定列，而是从右侧以覆盖式抽屉弹出
- `topbar` 与 `statusbar` 不直接横向铺开，而是收纳成顶部/底部气泡菜单入口
- 移动端顶部 detail header 由 `mobileHeader` 提供内容

移动端主屏切换不再由页面通过 `layoutRef.openDetail()` 之类的方式直接驱动，而由统一 runtime 控制。

## 核心架构分层

### 1. WorkbenchShell

`WorkbenchShell` 是唯一工作台外壳，负责：

- 全局导航承载
- 桌面/移动端布局编排
- 各区域 slot/占位渲染
- `list/main` 切换
- `auxPane` 抽屉显隐
- 顶部/底部气泡菜单显隐
- 默认区域开关

它不直接理解 `sessions`、`config`、`data` 等业务语义。

### 2. WorkbenchRegistry

`WorkbenchRegistry` 负责静态注册每个 section：

- section 的 id、标题、图标、路由名
- section 提供了哪些区域内容
- section 的移动端流转偏好
- section 的默认区域显隐偏好

第一阶段只需要仓库内静态 registry，不做运行时插件式动态注册。

### 3. WorkbenchRuntime

`WorkbenchRuntime` 负责工作台运行时状态，例如：

- 当前 section
- 当前移动端主屏是 `list` 还是 `main`
- `auxPane` 是否打开
- 顶部/底部气泡菜单是否打开

它是工作台层的统一交互入口，替代当前页面通过 layout ref 直接操纵壳子的模式。

### 4. Section Contribution

每个 section 通过注册对象描述自己对各区域的内容贡献，而不是直接定义页面壳。

### 5. Domain State

每个 section 的业务状态仍保留在自己的 composable/store 中，例如：

- `useConfigSection()`
- `useDataSection()`
- `useSessionsSection()`

业务状态不进入 registry。

## Registry Contract

推荐的 section 注册对象如下：

```ts
type WorkbenchSection = {
  id: string
  title: string
  icon?: Component
  routeName: string

  regions: {
    listPane?: Component
    mainPane: Component
    auxPane?: Component
    topbar?: Component
    statusbar?: Component
    mobileHeader?: Component
    mobileTopMenu?: Component
    mobileBottomMenu?: Component
  }

  layout: {
    mobileMainFlow: "list-main" | "main-only"
    auxMode: "inline" | "drawer"
    defaults?: {
      topbar?: boolean
      auxPane?: boolean
      statusbar?: boolean
    }
  }
}
```

设计要求：

- `mainPane` 必填，其余区域可选
- `topbar`、`auxPane`、`statusbar` 即便第一阶段不完整实现，也必须先进入 contract
- `layout` 只表达偏好，不表达具体布局代码

## Runtime Contract

推荐的 workbench runtime API 如下：

```ts
type WorkbenchRuntime = {
  activeSectionId: Ref<string>

  mobileScreen: Ref<"list" | "main">
  auxOpen: Ref<boolean>
  topMenuOpen: Ref<boolean>
  bottomMenuOpen: Ref<boolean>

  showList(): void
  showMain(): void
  openAux(): void
  closeAux(): void
  toggleTopMenu(): void
  toggleBottomMenu(): void
}
```

设计要求：

- section 内的交互只通过 runtime 请求切换工作台状态
- 业务组件不再直接持有 layout ref 并调用壳组件暴露的方法
- `showMain()` 将替代当前 `openDetail()` 的移动端切屏用途

## 目录重组建议

推荐目录如下：

```text
webui/src/
  components/
    workbench/
      WorkbenchShell.vue
      SectionHost.vue
      DesktopWorkbench.vue
      MobileWorkbench.vue
      panes/
        PaneFrame.vue
        PaneHeader.vue
        PaneBody.vue
        DrawerPane.vue
        BubbleMenu.vue
        TopBar.vue
        StatusBar.vue

  composables/
    workbench/
      useWorkbenchRuntime.ts
      useWorkbenchRegistry.ts
    sections/
      useSessionsSection.ts
      useConfigSection.ts
      useDataSection.ts

  sections/
    registry.ts
    sessions/
      index.ts
      SessionsListPane.vue
      SessionsMainPane.vue
      SessionsAuxPane.vue
      SessionsTopBar.vue
      SessionsStatusBar.vue
      SessionsMobileMenus.vue
    config/
      index.ts
      ConfigListPane.vue
      ConfigMainPane.vue
      ConfigMobileHeader.vue
    data/
      index.ts
      DataListPane.vue
      DataMainPane.vue
      DataMobileHeader.vue
    settings/
      index.ts
      SettingsListPane.vue
      SettingsMainPane.vue
      SettingsMobileHeader.vue
```

## 现有文件映射

### AppLayout

现有 [AppLayout.vue](../../../webui/src/components/layout/AppLayout.vue:1) 混合承担了：

- 工作台外壳
- 移动端 `list/main` 切换
- 移动端 header
- 路由标签

未来应拆成：

- `WorkbenchShell.vue`
- `DesktopWorkbench.vue`
- `MobileWorkbench.vue`
- `useWorkbenchRuntime.ts`

`AppLayout` 不应继续作为长期核心抽象扩张。

### ActivityBar

现有 [ActivityBar.vue](../../../webui/src/components/layout/ActivityBar.vue:1) 应保留为工作台固定导航区的一部分，但其菜单来源应收口到 workbench 配置或 registry，而不是页面局部。

### Pages

现有 `SessionsPage`、`ConfigPage`、`DataPage`、`WorkspacePage`、`SettingsPage` 都应从“拥有完整布局的页面”转为“仅选择 section 的路由入口”。

理想形态：

```vue
<template>
  <SectionHost section-id="config" />
</template>
```

### ChatPanel

[ChatPanel.vue](../../../webui/src/components/sessions/ChatPanel.vue:197) 暂不纳入第一轮布局抽象，它未来更适合作为 `SessionsMainPane` 内部的业务组件，而不是工作台层组件。

## 第一阶段实现范围

第一阶段采用：

- 接口按最终形态定
- 行为按最小子集实现

### 第一阶段必须实现

- `nav`
- `listPane`
- `mainPane`
- `mobileHeader`
- `mobileMainFlow`
- `WorkbenchRuntime.showMain() / showList()`

### 第一阶段进入 contract，但可先空实现或轻实现

- `topbar`
- `auxPane`
- `statusbar`
- `mobileTopMenu`
- `mobileBottomMenu`

这样第二阶段新增右侧抽屉、状态栏、气泡菜单时，不需要再修改 section 接口形状。

## 第一阶段迁移顺序

### 1. 建立最小 workbench 骨架

新增：

- `WorkbenchShell`
- `SectionHost`
- registry contract
- runtime contract

但第一轮只完整支持：

- `nav`
- `listPane`
- `mainPane`
- `mobileHeader`

### 2. 先迁 ConfigPage

[ConfigPage.vue](../../../webui/src/pages/ConfigPage.vue:102) 最适合作为第一批：

- 天然就是左侧清单 + 主区详情
- 重复结构明显
- 业务复杂度可控

拆成：

- `sections/config/index.ts`
- `ConfigListPane.vue`
- `ConfigMainPane.vue`
- `ConfigMobileHeader.vue`

### 3. 再迁 DataPage

[DataPage.vue](../../../webui/src/pages/DataPage.vue:226) 作为第二批，用来验证：

- list/detail 结构的通用性
- 子层级目录项选择的适配能力

### 4. 再迁 SettingsPage

[SettingsPage.vue](../../../webui/src/pages/SettingsPage.vue:127) 作为第三批，用来验证：

- 左侧切换项
- 主区内容
- 移动端 header

### 5. WorkspacePage 第二批后段迁移

[WorkspacePage.vue](../../../webui/src/pages/WorkspacePage.vue:157) 应在 `Config/Data/Settings` 收口后再迁，用它验证：

- 多模式 pane 内容
- 图片预览
- 未来 `auxPane` 的适配潜力

### 6. SessionsPage 最后迁移

[SessionsPage.vue](../../../webui/src/pages/SessionsPage.vue:129) 不应成为第一轮抽象的依据。

原因：

- 其内部业务最复杂
- [ChatPanel.vue](../../../webui/src/components/sessions/ChatPanel.vue:197) 已经内嵌了自己的多层布局
- 如果一开始就用它定义工作台抽象，容易把业务特例抬升到框架层

## 第一阶段明确不做的事

- 不迁移 `SessionsPage`
- 不要求 `WorkspacePage` 立刻支持右侧抽屉
- 不要求 `topbar`、`statusbar` 在第一轮就具备完整功能
- 不要求所有 header 立刻独立拆出为专门组件
- 不实现运行时第三方插件注册
- 不实现拖拽布局或自由停靠

## 预期结果

完成第一阶段后，当前 WebUI 应达到：

- `Config` / `Data` / `Settings` 不再各自拥有整套页面布局
- 工作台层形成明确的 shell / registry / runtime / section 内容分层
- 移动端主屏切换行为不再由页面直接操纵壳子
- 未来新增 `topbar`、`auxPane`、`statusbar`、移动端气泡菜单时，可以在既有 contract 上增量实现
- 当前仓库的布局结构自然收敛到后续可抽为共享包的方向

## 推荐结论

本项目应按以下策略推进：

- 架构目标按完整 `C` 形态设计
- 第一阶段实现按最小子集推进
- 先用 `Config` / `Data` / `Settings` 收敛真实结构
- 等工作台边界稳定后，再迁 `Workspace` 与 `Sessions`

这个路径既能避免临时接口返工，也能避免过早落入过度抽象。

## Phase 1 Status Notes

- `Config / Data / Settings` 已切到 `SectionHost`，并通过 registry 注册 `listPane / mainPane / mobileHeader`
- `Sessions / Workspace` 仍保留旧布局，作为第二阶段迁移对象
- `topbar / auxPane / statusbar / mobile menus` 已进入 contract，但当前仍为壳层占位，尚未对业务页开放

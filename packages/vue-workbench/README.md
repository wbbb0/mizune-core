# @workbench-kit/vue-workbench

Vue 3 工作台外壳包，提供桌面/移动端布局、导航、菜单、toast、窗口、基础 primitives 和 workbench 基础样式。

这个包只负责通用工作台能力，不依赖业务项目的 router、store、API adapter 或具体 section。业务项目通过 props、类型契约和 composable 把自己的页面接入 workbench。

## 依赖

业务项目需要提供 peer dependencies：

```bash
npm install vue lucide-vue-next
```

当前仓库内通过源码 alias 使用：

```json
{
  "paths": {
    "@workbench-kit/vue-workbench": ["../packages/vue-workbench/src/index.ts"],
    "@workbench-kit/vue-workbench/runtime": ["../packages/vue-workbench/src/runtime-api.ts"]
  }
}
```

迁出独立仓库并发布后，业务项目应改为普通依赖：

```bash
npm install @workbench-kit/vue-workbench
```

## 样式接入

业务项目必须先定义主题 token，再引入 Tailwind 和 workbench 基础样式：

```css
@import "./theme.css";
@import "tailwindcss";
@import "tailwindcss-safe-area";
@import "@workbench-kit/vue-workbench/style.css";
```

`theme.css` 至少需要提供这些 token：

```css
:root,
html[data-theme="dark"] {
  --surface-app: #0b1220;
  --surface-sidebar: #101827;
  --surface-panel: #121c2d;
  --surface-input: #182335;
  --surface-muted: #1a2537;
  --surface-hover: #172338;
  --surface-active: #21314a;
  --surface-selected: #16365f;
  --surface-selected-muted: #15253d;

  --border-subtle: color-mix(in srgb, #31415c 64%, transparent);
  --border-default: #2b3a54;
  --border-strong: #41526f;
  --border-focus: #4ea3ff;
  --border-input: #31415c;

  --text-primary: #d6deea;
  --text-secondary: #f2f6fd;
  --text-muted: #93a3bd;
  --text-subtle: #677891;
  --text-accent: #83c4ff;
  --text-on-accent: #ffffff;

  --accent: #3f9cff;
  --accent-hover: #5caeff;
  --success: #47c59d;
  --warning: #e5ba62;
  --danger: #f26d7d;
  --info: #72c6ff;

  --surface-success: color-mix(in srgb, var(--success) 18%, var(--surface-panel));
  --surface-warning: color-mix(in srgb, var(--warning) 16%, var(--surface-panel));
  --surface-danger: color-mix(in srgb, var(--danger) 14%, var(--surface-panel));
  --surface-info: color-mix(in srgb, var(--info) 14%, var(--surface-panel));

  --scrollbar-bg: transparent;
  --scrollbar-thumb: #33445f;
  --scrollbar-thumb-hover: #415674;

  --activity-bar-width: 48px;
  --font-size-ui: 13px;
  --font-size-small: 11px;
  --font-size-mono: 12px;
  --line-height-ui: 1.4;
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
}
```

`style.css` 会把这些 token 映射成 Tailwind v4 theme token，例如 `bg-surface-panel`、`border-border-default`、`text-text-muted`、`text-ui`、`font-ui`。

## Tailwind source

Tailwind v4 只会为扫描到的 class 生成 CSS。源码包位于业务项目源码目录之外时，必须在 CSS 入口声明 source：

```css
@source "../../../packages/vue-workbench/src";
```

路径以当前 CSS 文件位置为准。本仓库的 `webui/src/style/main.css` 位于 `webui/src/style/`，所以使用 `../../../packages/vue-workbench/src`。

如果包来自 `node_modules`，路径通常类似：

```css
@source "../node_modules/@workbench-kit/vue-workbench";
```

缺少 `@source` 时，包内组件的 utility 不会生成，常见表现包括 activity bar 宽度、安全区 padding、伪元素和颜色类失效，例如：

- `pl-safe`
- `w-[calc(var(--activity-bar-width)+env(safe-area-inset-left))]`
- `h-(--activity-bar-width)`
- `bg-surface-sidebar`
- `text-text-muted`
- `before:bg-text-secondary`

## 入口

常规组件入口：

```ts
import {
  WorkbenchRoot,
  defineWorkbenchView,
  useWorkbenchNavigation,
  useWorkbenchToasts,
  useWorkbenchWindows,
  WorkbenchAreaHeader,
  WorkbenchCard,
  WorkbenchDisclosure,
  WorkbenchEmptyState,
  WorkbenchListItem,
  TreeNodeShell
} from "@workbench-kit/vue-workbench";
```

纯运行时或测试场景使用子入口，避免加载 `.vue` 组件：

```ts
import {
  createWindowManager,
  resolveWindowSizing
} from "@workbench-kit/vue-workbench/runtime";
```

## 挂载 WorkbenchRoot

业务项目负责选择当前 view、传入导航项和处理导航行为：

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { MessageSquare } from "lucide-vue-next";
import { WorkbenchRoot, defineWorkbenchView } from "@workbench-kit/vue-workbench";
import SessionsListPane from "./sections/sessions/SessionsListPane.vue";
import SessionsMainPane from "./sections/sessions/SessionsMainPane.vue";

const router = useRouter();

const sessionsView = defineWorkbenchView({
  id: "sessions",
  title: "Sessions",
  areas: {
    primarySidebar: SessionsListPane,
    mainArea: SessionsMainPane
  },
  layout: {
    mobile: {
      rootArea: "primarySidebar"
    },
    desktop: {
      primarySidebar: {
        defaultSizePx: 280,
        minSizePx: 220,
        maxSizePx: 520
      }
    }
  }
});

const activeView = computed(() => sessionsView);
const navItems = [
  {
    id: "sessions",
    title: "Sessions",
    icon: MessageSquare,
    placement: "primary" as const
  }
];
</script>

<template>
  <WorkbenchRoot
    :view="activeView"
    :nav-items="navItems"
    active-nav-item-id="sessions"
    :topbar-menus="[]"
    :statusbar-items="[]"
    :is-mobile="false"
    @navigate="(itemId) => router.push({ name: itemId })"
  />
</template>
```

`WorkbenchRoot` 会创建 controller，并挂载 `WorkbenchShell`、`MenuHost`、`ToastViewport` 和 `WindowHost`。业务项目通常不需要直接挂载这些内部 host。

## View contract

每个 view 至少包含 `id`、`title` 和 `areas.mainArea`：

```ts
defineWorkbenchView({
  id: "config",
  title: "Config",
  areas: {
    mainArea: ConfigMainPane
  }
});
```

可选区域：

- `primarySidebar`
- `secondarySidebar`
- `bottomPanel`
- `mobileHeader`

可选布局：

```ts
layout: {
  mobile: {
    rootArea: "primarySidebar"
  },
  desktop: {
    primarySidebar: {
      defaultSizePx: 280,
      minSizePx: 220,
      maxSizePx: 520
    },
    secondarySidebar: {
      defaultSizePx: 320
    },
    bottomPanel: {
      defaultSizePx: 240,
      minSizePx: 120
    }
  }
}
```

桌面 pane 尺寸由 workbench runtime 统一维护并写入 `localStorage`，section 不应自己保存 pane 宽高。

## Runtime composables

在 `WorkbenchRoot` 挂载后，section 和普通组件可以使用：

```ts
import {
  useWorkbenchNavigation,
  useWorkbenchToasts,
  useWorkbenchWindows
} from "@workbench-kit/vue-workbench";

const navigation = useWorkbenchNavigation();
const toast = useWorkbenchToasts();
const windows = useWorkbenchWindows();

navigation.showArea("mainArea");
toast.push({ type: "success", message: "已保存" });

const result = await windows.openDialog({
  title: "创建会话",
  size: "sm",
  schema: {
    fields: [
      {
        kind: "string",
        key: "title",
        label: "标题",
        required: true
      }
    ]
  },
  actions: [
    {
      id: "create",
      label: "创建",
      variant: "primary",
      run: ({ values }) => values
    }
  ]
});
```

这些 composable 依赖 active controller。没有挂载 `WorkbenchRoot` 时，窗口和 toast 服务不可用。

## 顶部菜单和状态栏

顶部菜单由结构化 `MenuNode[]` 描述：

```ts
import type { WorkbenchTopbarMenu } from "@workbench-kit/vue-workbench";

const topbarMenus: WorkbenchTopbarMenu[] = [
  {
    id: "view",
    label: "视图",
    resolveItems: () => [
      {
        kind: "action",
        id: "reload",
        label: "重新加载",
        onSelect: () => reload()
      },
      {
        kind: "separator",
        id: "sep-1"
      }
    ]
  }
];
```

状态栏项以组件形式传入：

```ts
import type { WorkbenchStatusbarItem } from "@workbench-kit/vue-workbench";

const statusbarItems: WorkbenchStatusbarItem[] = [
  {
    id: "backend",
    component: BackendStatusChip,
    props: {
      backendId: activeBackendId.value
    }
  }
];
```

## Public primitives

- `TreeNodeShell`
- `WorkbenchAreaHeader`
- `WorkbenchCard`
- `WorkbenchDisclosure`
- `WorkbenchEmptyState`
- `WorkbenchListItem`

这些组件只承担稳定视觉结构，不绑定业务数据。

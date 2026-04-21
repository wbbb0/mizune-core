# Workbench Global Chrome And Menu System Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 workbench 增加桌面端固定 `TopBar + StatusBar`，并引入一套可同时承接移动端工作台菜单与右键菜单的统一 `MenuHost`。

**Architecture:** 保持现有 section/page 结构不变，只在 shell 层新增全局 chrome 与菜单运行时。桌面端直接渲染完整栏位；移动端通过一个固定入口按钮打开一级工作台菜单，再通过两个子菜单进入工具栏和状态栏内容。

**Tech Stack:** Vue 3、TypeScript、Vue Router、Tailwind、node:test、tsx

---

## 文件边界

- 新增 `webui/src/components/menu/types.ts`
  - 菜单节点模型与菜单上下文类型
- 新增 `webui/src/composables/menu/useMenuRuntime.ts`
  - 全局菜单栈与打开/关闭 API
- 新增 `webui/src/components/menu/MenuHost.vue`
  - 统一渲染一级菜单与子菜单
- 新增 `webui/src/components/menu/MenuList.vue`
  - 结构化菜单项与 `component` 叶子节点的列表渲染
- 新增 `webui/src/components/workbench/TopBar.vue`
  - 桌面固定工具栏
- 新增 `webui/src/components/workbench/StatusBar.vue`
  - 桌面固定状态栏
- 新增 `webui/src/components/workbench/status/ConnectionStatusChip.vue`
  - 状态栏状态组件 1
- 新增 `webui/src/components/workbench/status/InstanceStatusChip.vue`
  - 状态栏状态组件 2
- 新增 `webui/src/components/workbench/DesktopWorkbench.vue`
  - 桌面壳体编排
- 新增 `webui/src/components/workbench/MobileWorkbench.vue`
  - 移动端壳体编排与单入口菜单按钮
- 修改 `webui/src/components/workbench/WorkbenchShell.vue`
  - 改为桌面/移动壳体分发器
- 修改 `webui/src/composables/workbench/useWorkbenchRuntime.ts`
  - 去掉旧的顶栏/底栏菜单开关，只保留主体切换/aux
- 可能修改 `webui/src/components/workbench/navigation.ts`
  - 如果需要为移动端固定菜单按钮补图标
- 新增测试 `test/webui/layout/menu-runtime-source.test.ts`
  - 校验菜单模型与运行时 API
- 修改 `test/webui/layout/app-layout.test.tsx`
  - 更新 safe-area 归属断言，从 shell 根迁移到 `TopBar`
- 修改 `test/webui/layout/workbench-registry-source.test.ts`
  - 更新 runtime 断言，不再检查旧 `topMenuOpen/bottomMenuOpen`
- 新增测试 `test/webui/layout/workbench-global-chrome-source.test.ts`
  - 校验 `WorkbenchShell` 固定渲染 `TopBar` / `StatusBar` 与移动端单按钮结构

### Task 1: 菜单模型与运行时

**Files:**
- Create: `webui/src/components/menu/types.ts`
- Create: `webui/src/composables/menu/useMenuRuntime.ts`
- Test: `test/webui/layout/menu-runtime-source.test.ts`
- Modify: `test/webui/layout/workbench-registry-source.test.ts`

- [ ] **Step 1: 写失败测试，钉住菜单模型与运行时 API**

```ts
test("menu runtime exposes a global menu stack and component leaf nodes stay childless", async () => {
  const menuTypesSource = await readFile(
    new URL("../../../webui/src/components/menu/types.ts", import.meta.url),
    "utf8"
  );
  const menuRuntimeSource = await readFile(
    new URL("../../../webui/src/composables/menu/useMenuRuntime.ts", import.meta.url),
    "utf8"
  );

  assert.match(menuTypesSource, /kind: "submenu"/);
  assert.match(menuTypesSource, /children: MenuNode\[\]/);
  assert.match(menuTypesSource, /kind: "component"/);
  assert.doesNotMatch(menuTypesSource, /kind: "component"[\s\S]*children:/);

  assert.match(menuRuntimeSource, /const openMenus = ref<MenuStackEntry\[\]>\(\[\]\)/);
  assert.match(menuRuntimeSource, /function openMenu\(/);
  assert.match(menuRuntimeSource, /function openSubmenu\(/);
  assert.match(menuRuntimeSource, /function closeMenu\(/);
  assert.match(menuRuntimeSource, /function closeAllMenus\(/);
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `node --test test/webui/layout/menu-runtime-source.test.ts test/webui/layout/workbench-registry-source.test.ts`

Expected:
- `menu-runtime-source.test.ts` 因文件不存在失败
- `workbench-registry-source.test.ts` 仍通过

- [ ] **Step 3: 写最小实现**

`webui/src/components/menu/types.ts`

```ts
import type { Component } from "vue";

export type MenuNode =
  | { kind: "action"; id: string; label: string; icon?: Component; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: "toggle"; id: string; label: string; checked: boolean; disabled?: boolean; onToggle: (next: boolean) => void }
  | { kind: "radio"; id: string; label: string; checked: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: "submenu"; id: string; label: string; icon?: Component; disabled?: boolean; children: MenuNode[] }
  | { kind: "group"; id: string; label?: string; children: MenuNode[] }
  | { kind: "separator"; id: string }
  | { kind: "component"; id: string; component: Component; props?: Record<string, unknown>; width?: "sm" | "md" | "lg" | "fit"; closeOnInteract?: boolean };

export type MenuAnchor = { x: number; y: number } | { element: HTMLElement | null };

export type MenuStackEntry = {
  id: string;
  items: MenuNode[];
  anchor: MenuAnchor;
  source: "mobile-workbench" | "topbar" | "statusbar" | "contextmenu";
  parentId?: string;
};
```

`webui/src/composables/menu/useMenuRuntime.ts`

```ts
import { ref } from "vue";
import type { MenuStackEntry } from "@/components/menu/types";

const openMenus = ref<MenuStackEntry[]>([]);

function openMenu(entry: MenuStackEntry) {
  openMenus.value = [entry];
}

function openSubmenu(entry: MenuStackEntry) {
  const nextMenus = entry.parentId
    ? openMenus.value.filter((menu) => menu.id === entry.parentId || menu.parentId !== entry.parentId)
    : openMenus.value;
  openMenus.value = [...nextMenus.filter((menu) => menu.id !== entry.id), entry];
}

function closeMenu(id: string) {
  openMenus.value = openMenus.value.filter((menu) => menu.id !== id && menu.parentId !== id);
}

function closeAllMenus() {
  openMenus.value = [];
}

export function useMenuRuntime() {
  return { openMenus, openMenu, openSubmenu, closeMenu, closeAllMenus };
}
```

- [ ] **Step 4: 更新 workbench runtime 测试预期**

把 `test/webui/layout/workbench-registry-source.test.ts` 中对 `topMenuOpen / bottomMenuOpen / toggleTopMenu / toggleBottomMenu` 的断言改成：

```ts
assert.doesNotMatch(source, /topMenuOpen/);
assert.doesNotMatch(source, /bottomMenuOpen/);
assert.doesNotMatch(source, /toggleTopMenu/);
assert.doesNotMatch(source, /toggleBottomMenu/);
```

- [ ] **Step 5: 跑测试确认绿灯**

Run: `node --test test/webui/layout/menu-runtime-source.test.ts test/webui/layout/workbench-registry-source.test.ts`

Expected: 全部 PASS

### Task 2: 桌面固定 TopBar / StatusBar 与 safe-area 迁移

**Files:**
- Create: `webui/src/components/workbench/TopBar.vue`
- Create: `webui/src/components/workbench/StatusBar.vue`
- Create: `webui/src/components/workbench/status/ConnectionStatusChip.vue`
- Create: `webui/src/components/workbench/status/InstanceStatusChip.vue`
- Create: `webui/src/components/workbench/DesktopWorkbench.vue`
- Modify: `webui/src/components/workbench/WorkbenchShell.vue`
- Test: `test/webui/layout/app-layout.test.tsx`
- Test: `test/webui/layout/workbench-global-chrome-source.test.ts`

- [ ] **Step 1: 写失败测试，锁定全局 chrome 和 safe-area 新归属**

`test/webui/layout/workbench-global-chrome-source.test.ts`

```ts
test("workbench shell delegates desktop rendering to a dedicated desktop shell with fixed chrome", async () => {
  const shellSource = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");
  const desktopSource = await readFile(new URL("../../../webui/src/components/workbench/DesktopWorkbench.vue", import.meta.url), "utf8");
  const topBarSource = await readFile(new URL("../../../webui/src/components/workbench/TopBar.vue", import.meta.url), "utf8");
  const statusBarSource = await readFile(new URL("../../../webui/src/components/workbench/StatusBar.vue", import.meta.url), "utf8");

  assert.match(shellSource, /from "@\/components\/workbench\/DesktopWorkbench\.vue"/);
  assert.match(desktopSource, /<TopBar \/>/);
  assert.match(desktopSource, /<StatusBar \/>/);
  assert.match(topBarSource, /pt-safe/);
  assert.match(statusBarSource, /ConnectionStatusChip/);
  assert.match(statusBarSource, /InstanceStatusChip/);
});
```

把 `test/webui/layout/app-layout.test.tsx` 的旧断言：

```ts
assert.match(workbenchShellSource, /:class="ui\.isMobile \? 'fixed inset-0' : 'relative pt-safe'"/);
```

改成：

```ts
assert.doesNotMatch(workbenchShellSource, /pt-safe/);
assert.match(topBarSource, /pt-safe/);
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `node --test test/webui/layout/workbench-global-chrome-source.test.ts && npx tsx --test test/webui/layout/app-layout.test.tsx`

Expected:
- 新测试因文件不存在失败
- `app-layout.test.tsx` 因断言还未更新失败

- [ ] **Step 3: 写最小实现**

`webui/src/components/workbench/TopBar.vue`

```vue
<script setup lang="ts">
import { useMenuRuntime } from "@/composables/menu/useMenuRuntime";

const { openMenu } = useMenuRuntime();

function openTopbarMenu(event: MouseEvent) {
  openMenu({
    id: "desktop-topbar-menu",
    source: "topbar",
    anchor: { element: event.currentTarget as HTMLElement | null },
    items: [{ kind: "action", id: "placeholder", label: "菜单占位", onSelect: () => {} }]
  });
}
</script>

<template>
  <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center border-b border-border-default bg-surface-sidebar px-3">
    <button class="rounded px-2 py-1 text-sm text-text-secondary" @click="openTopbarMenu">菜单</button>
    <div class="min-w-0 flex-1" />
  </header>
</template>
```

`webui/src/components/workbench/status/ConnectionStatusChip.vue`

```vue
<template>
  <div class="rounded px-2 py-1 text-xs text-text-secondary">连接正常</div>
</template>
```

`webui/src/components/workbench/status/InstanceStatusChip.vue`

```vue
<template>
  <div class="rounded px-2 py-1 text-xs text-text-secondary">默认实例</div>
</template>
```

`webui/src/components/workbench/StatusBar.vue`

```vue
<script setup lang="ts">
import ConnectionStatusChip from "@/components/workbench/status/ConnectionStatusChip.vue";
import InstanceStatusChip from "@/components/workbench/status/InstanceStatusChip.vue";
</script>

<template>
  <footer class="pb-safe flex min-h-[32px] shrink-0 items-center gap-2 border-t border-border-default bg-surface-sidebar px-2">
    <ConnectionStatusChip />
    <InstanceStatusChip />
  </footer>
</template>
```

`webui/src/components/workbench/DesktopWorkbench.vue`

```vue
<script setup lang="ts">
import { computed } from "vue";
import ActivityBar from "@/components/layout/ActivityBar.vue";
import TopBar from "@/components/workbench/TopBar.vue";
import StatusBar from "@/components/workbench/StatusBar.vue";
import type { WorkbenchSection } from "@/components/workbench/types";

const props = defineProps<{ section: WorkbenchSection }>();
const listPane = computed(() => props.section.regions.listPane);
const mainPane = computed(() => props.section.regions.mainPane);
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden bg-surface-app text-text-primary">
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TopBar />
      <div class="min-h-0 flex flex-1 overflow-hidden">
        <ActivityBar />
        <aside class="scrollbar-thin w-(--side-panel-width) shrink-0 overflow-x-hidden overflow-y-auto border-r border-border-default bg-surface-sidebar">
          <component :is="listPane" v-if="section.regions.listPane" />
        </aside>
        <main class="flex min-w-0 flex-1 flex-col overflow-hidden pr-safe">
          <component :is="mainPane" />
        </main>
      </div>
      <StatusBar />
    </div>
  </div>
</template>
```

`webui/src/components/workbench/WorkbenchShell.vue`

```vue
<script setup lang="ts">
import { useUiStore } from "@/stores/ui";
import DesktopWorkbench from "@/components/workbench/DesktopWorkbench.vue";
import MobileWorkbench from "@/components/workbench/MobileWorkbench.vue";
import type { WorkbenchSection } from "@/components/workbench/types";

defineProps<{ section: WorkbenchSection }>();
const ui = useUiStore();
</script>

<template>
  <DesktopWorkbench v-if="!ui.isMobile" :section="section" />
  <MobileWorkbench v-else :section="section" />
</template>
```

- [ ] **Step 4: 跑测试确认绿灯**

Run:
- `node --test test/webui/layout/workbench-global-chrome-source.test.ts`
- `npx tsx --test test/webui/layout/app-layout.test.tsx`

Expected: 全部 PASS

### Task 3: MenuHost 与移动端单入口菜单

**Files:**
- Create: `webui/src/components/menu/MenuHost.vue`
- Create: `webui/src/components/menu/MenuList.vue`
- Create: `webui/src/components/workbench/MobileWorkbench.vue`
- Modify: `webui/src/components/workbench/WorkbenchShell.vue`
- Test: `test/webui/layout/workbench-global-chrome-source.test.ts`

- [ ] **Step 1: 写失败测试，钉住移动端单入口 + 双子菜单**

在 `test/webui/layout/workbench-global-chrome-source.test.ts` 增加：

```ts
test("mobile workbench uses one fixed trigger that opens a root menu with topbar and statusbar submenus", async () => {
  const mobileSource = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");
  const menuHostSource = await readFile(new URL("../../../webui/src/components/menu/MenuHost.vue", import.meta.url), "utf8");

  assert.match(mobileSource, /openMenu\(\{/);
  assert.match(mobileSource, /id: "mobile-workbench-menu"/);
  assert.match(mobileSource, /label: "工具栏"/);
  assert.match(mobileSource, /label: "状态栏"/);
  assert.match(mobileSource, /kind: "submenu"/);
  assert.match(menuHostSource, /openMenus/);
});
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `node --test test/webui/layout/workbench-global-chrome-source.test.ts`

Expected: 因 `MobileWorkbench.vue` / `MenuHost.vue` 缺失失败

- [ ] **Step 3: 写最小实现**

`webui/src/components/menu/MenuList.vue`

```vue
<script setup lang="ts">
import type { MenuNode } from "@/components/menu/types";
import { useMenuRuntime } from "@/composables/menu/useMenuRuntime";

const props = defineProps<{ items: MenuNode[]; menuId: string }>();
const { openSubmenu, closeAllMenus } = useMenuRuntime();

function onSelect(item: MenuNode, event: MouseEvent) {
  if (item.kind === "action") {
    item.onSelect();
    closeAllMenus();
    return;
  }
  if (item.kind === "submenu") {
    openSubmenu({
      id: `${props.menuId}:${item.id}`,
      parentId: props.menuId,
      source: "mobile-workbench",
      anchor: { element: event.currentTarget as HTMLElement | null },
      items: item.children
    });
  }
}
</script>
```

`webui/src/components/menu/MenuHost.vue`

```vue
<script setup lang="ts">
import MenuList from "@/components/menu/MenuList.vue";
import { useMenuRuntime } from "@/composables/menu/useMenuRuntime";

const { openMenus } = useMenuRuntime();
</script>

<template>
  <div class="pointer-events-none fixed inset-0 z-50">
    <div v-for="menu in openMenus" :key="menu.id" class="pointer-events-auto absolute left-3 top-14 min-w-48 rounded border border-border-default bg-surface-panel shadow-lg">
      <MenuList :items="menu.items" :menu-id="menu.id" />
    </div>
  </div>
</template>
```

`webui/src/components/workbench/MobileWorkbench.vue`

```vue
<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import ActivityBar from "@/components/layout/ActivityBar.vue";
import { workbenchNavItems } from "@/components/workbench/navigation";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";
import { useMenuRuntime } from "@/composables/menu/useMenuRuntime";
import type { MenuNode } from "@/components/menu/types";
import type { WorkbenchSection } from "@/components/workbench/types";

const props = defineProps<{ section: WorkbenchSection }>();
const route = useRoute();
const { mobileScreen, showList, showMain } = useWorkbenchRuntime();
const { openMenu } = useMenuRuntime();

const listPane = computed(() => props.section.regions.listPane);
const mainPane = computed(() => props.section.regions.mainPane);
const mobileHeader = computed(() => props.section.regions.mobileHeader);
const routeLabel = computed(() => props.section.title || workbenchNavItems.find((item) => item.id === route.name)?.title || "");

const topBarMenuNodes: MenuNode[] = [{ kind: "action", id: "placeholder", label: "菜单占位", onSelect: () => {} }];
const statusBarMenuNodes: MenuNode[] = [
  { kind: "component", id: "connection", component: (await import("@/components/workbench/status/ConnectionStatusChip.vue")).default },
  { kind: "component", id: "instance", component: (await import("@/components/workbench/status/InstanceStatusChip.vue")).default }
];

function openWorkbenchMenu(event: MouseEvent) {
  openMenu({
    id: "mobile-workbench-menu",
    source: "mobile-workbench",
    anchor: { element: event.currentTarget as HTMLElement | null },
    items: [
      { kind: "submenu", id: "mobile-topbar", label: "工具栏", children: topBarMenuNodes },
      { kind: "submenu", id: "mobile-statusbar", label: "状态栏", children: statusBarMenuNodes }
    ]
  });
}

watch(
  () => props.section.layout.mobileMainFlow,
  (mobileMainFlow) => {
    if (mobileMainFlow === "main-only") {
      showMain();
      return;
    }
    showList();
  },
  { immediate: true }
);
</script>
```

- [ ] **Step 4: 跑测试确认绿灯**

Run: `node --test test/webui/layout/workbench-global-chrome-source.test.ts`

Expected: PASS

### Task 4: 接上真实渲染并做回归验证

**Files:**
- Modify: `webui/src/components/menu/MenuList.vue`
- Modify: `webui/src/components/menu/MenuHost.vue`
- Modify: `webui/src/components/workbench/MobileWorkbench.vue`
- Modify: `webui/src/composables/workbench/useWorkbenchRuntime.ts`
- Test: `test/webui/layout/workbench-registry-source.test.ts`
- Test: `test/webui/layout/app-layout.test.tsx`
- Test: `test/webui/layout/workbench-global-chrome-source.test.ts`

- [ ] **Step 1: 写失败测试，钉住旧 runtime 菜单状态被移除**

在 `test/webui/layout/workbench-registry-source.test.ts` 增加：

```ts
assert.match(source, /const auxOpen = ref\(false\)/);
assert.doesNotMatch(source, /topMenuOpen/);
assert.doesNotMatch(source, /bottomMenuOpen/);
assert.doesNotMatch(source, /toggleTopMenu/);
assert.doesNotMatch(source, /toggleBottomMenu/);
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `node --test test/webui/layout/workbench-registry-source.test.ts`

Expected: 因旧字段仍存在失败

- [ ] **Step 3: 写最小实现**

把 `webui/src/composables/workbench/useWorkbenchRuntime.ts` 收敛为：

```ts
import { ref } from "vue";

const mobileScreen = ref<"list" | "main">("list");
const auxOpen = ref(false);

function showList() {
  mobileScreen.value = "list";
}

function showMain() {
  mobileScreen.value = "main";
}

function openAux() {
  auxOpen.value = true;
}

function closeAux() {
  auxOpen.value = false;
}

export function useWorkbenchRuntime() {
  return { mobileScreen, auxOpen, showList, showMain, openAux, closeAux };
}
```

同时把 `MenuList.vue` 补成最小可渲染版本：

```vue
<template>
  <div class="flex min-w-48 flex-col py-1">
    <template v-for="item in items" :key="item.id">
      <button
        v-if="item.kind === 'action' || item.kind === 'submenu'"
        class="flex items-center justify-between px-3 py-2 text-left text-sm text-text-primary"
        @click="onSelect(item, $event)"
      >
        <span>{{ item.label }}</span>
        <span v-if="item.kind === 'submenu'">›</span>
      </button>
      <div v-else-if="item.kind === 'separator'" class="my-1 border-t border-border-default" />
      <div v-else-if="item.kind === 'component'" class="px-2 py-2">
        <component :is="item.component" v-bind="item.props" />
      </div>
    </template>
  </div>
</template>
```

- [ ] **Step 4: 跑回归测试**

Run:
- `node --test test/webui/layout/menu-runtime-source.test.ts test/webui/layout/workbench-registry-source.test.ts test/webui/layout/workbench-global-chrome-source.test.ts test/webui/layout/section-host-source.test.ts test/webui/layout/section-migration-source.test.ts`
- `npx tsx --test test/webui/layout/app-layout.test.tsx`

Expected: 全部 PASS

- [ ] **Step 5: 运行前端构建级验证**

Run: `npm --prefix webui run build`

Expected:
- 如果当前 worktree 环境依赖齐全，应 PASS
- 如果因仓库既有环境问题失败，要记录具体输出并与本次改动区分

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/specs/2026-04-21-workbench-global-chrome-and-menu-system-design.md \
  docs/superpowers/plans/2026-04-21-workbench-global-chrome-and-menu-system-phase-1.md \
  webui/src/components/menu \
  webui/src/components/workbench \
  webui/src/composables/menu \
  webui/src/composables/workbench/useWorkbenchRuntime.ts \
  test/webui/layout
git commit -m "feat: add workbench global chrome and menu host"
```

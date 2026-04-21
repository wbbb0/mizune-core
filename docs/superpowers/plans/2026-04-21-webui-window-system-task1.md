# WebUI 统一窗口系统 Task 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 workbench 引入唯一的统一窗口系统，支持桌面端多窗口层级/拖拽/父子失活规则、移动端栈顶显示，以及字段/按钮/自定义块驱动的声明式对话 DSL。

**Architecture:** 新系统拆成两层：`windowManager + WindowHost + WindowSurface` 负责全局窗口栈与桌面/移动行为；`DialogRenderer + DialogSchema + DialogAction + DialogBlock` 负责窗口内容和结果返回。现有 `WorkbenchDialog` 降级为兼容包装层，`CreateSessionDialog`、`ImagePreviewDialog` 和会话操作弹窗逐步迁移到新系统。

**Tech Stack:** Vue 3、TypeScript、Vite、Tailwind、`node:test`、`tsx` 组件测试

---

## 文件结构

### 新增文件

- `webui/src/components/workbench/windows/WindowHost.vue`
  - workbench 根部唯一窗口宿主；桌面端渲染所有窗口，移动端只渲染栈顶窗口
- `webui/src/components/workbench/windows/WindowSurface.vue`
  - 单个窗口外壳；标题栏、关闭、拖拽、置顶、父子层级/失活样式
- `webui/src/components/workbench/windows/DialogRenderer.vue`
  - 根据 `schema/actions/blocks` 渲染字段、自定义块和动作按钮
- `webui/src/components/workbench/windows/windowSizing.ts`
  - `size` 到桌面/移动约束类名与内联样式映射
- `webui/src/components/workbench/windows/dialogSchemaAdapter.ts`
  - `SchemaMeta -> DialogField[]` 的受限适配器
- `webui/src/composables/workbench/windowManager.ts`
  - 纯状态管理器；窗口列表、层级、激活窗口、父子约束、结果 promise
- `webui/src/composables/workbench/useWorkbenchWindows.ts`
  - 供业务组件使用的窗口 API
- `webui/src/components/workbench/windows/types.ts`
  - `WindowDefinition`、`WindowResult`、`DialogSchema`、`DialogField`、`DialogAction`、`DialogBlock` 等类型
- `test/webui/windows/window-manager.test.ts`
  - 纯逻辑测试：层级、父子关系、移动端栈顺序
- `test/webui/windows/window-host.test.tsx`
  - 组件测试：桌面/移动渲染、置顶、父窗口失活
- `test/webui/windows/dialog-renderer.test.tsx`
  - 组件测试：字段值、动作回调、结果返回
- `test/webui/windows/schema-meta-adapter.test.ts`
  - 适配器测试：仅转换受支持字段
- `test/webui/windows/workbench-dialog-source.test.ts`
  - source test：限制兼容层只做桥接，不再自己 `teleport to="body"`

### 修改文件

- `webui/src/components/workbench/WorkbenchShell.vue`
  - 挂载 `WindowHost`
- `webui/src/components/common/WorkbenchDialog.vue`
  - 从旧单体弹窗改成兼容包装层
- `webui/src/components/common/ImagePreviewDialog.vue`
  - 改为通过统一窗口系统定义图片预览窗口
- `webui/src/components/sessions/CreateSessionDialog.vue`
  - 改为 DSL/窗口系统消费方
- `webui/src/components/sessions/ChatPanel.vue`
  - 迁移图片预览与会话操作窗口调用
- `webui/src/sections/sessions/SessionsListPane.vue`
  - 改为通过窗口系统打开创建会话与会话操作窗口
- `webui/src/sections/workspace/WorkspaceMainPane.vue`
  - 改为通过窗口系统打开图片预览
- `test/webui/layout/section-migration-source.test.ts`
  - 更新 source test，约束旧弹窗调用被迁移到窗口系统

### 现有文件参考

- `webui/src/components/common/WorkbenchDialog.vue`
- `webui/src/components/common/ImagePreviewDialog.vue`
- `webui/src/components/sessions/CreateSessionDialog.vue`
- `webui/src/components/workbench/WorkbenchShell.vue`
- `webui/src/composables/workbench/useWorkbenchRuntime.ts`
- `src/data/schema/index.ts`

---

### Task 1: 建立窗口类型与纯状态管理器

**Files:**
- Create: `webui/src/components/workbench/windows/types.ts`
- Create: `webui/src/composables/workbench/windowManager.ts`
- Test: `test/webui/windows/window-manager.test.ts`

- [ ] **Step 1: 写失败的窗口管理器测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowManager } from "../../../webui/src/composables/workbench/windowManager.ts";

test("child windows always stay above their ancestors", () => {
  const manager = createWindowManager();
  const parent = manager.openSync({ kind: "dialog", title: "Parent", size: "md" });
  const child = manager.openSync({ kind: "child-dialog", title: "Child", size: "sm", parentId: parent.id });

  manager.focus(parent.id);

  const order = manager.snapshot().map((item) => item.id);
  assert.deepEqual(order, [parent.id, child.id]);
  assert.equal(manager.snapshot().at(-1)?.id, child.id);
});

test("desktop dragging changes position but not child-over-parent order", () => {
  const manager = createWindowManager();
  const parent = manager.openSync({ kind: "dialog", title: "Parent", size: "md", movable: true });
  const child = manager.openSync({ kind: "child-dialog", title: "Child", size: "sm", parentId: parent.id });

  manager.move(parent.id, { x: 120, y: 40 });

  const parentWindow = manager.get(parent.id);
  assert.deepEqual(parentWindow?.position, { x: 120, y: 40 });
  assert.equal(manager.snapshot().at(-1)?.id, child.id);
});

test("mobile mode exposes only the top-most window", () => {
  const manager = createWindowManager();
  const first = manager.openSync({ kind: "dialog", title: "First", size: "md" });
  const second = manager.openSync({ kind: "dialog", title: "Second", size: "md" });

  const topOnly = manager.visibleStack("mobile").map((item) => item.id);
  assert.deepEqual(topOnly, [second.id]);

  manager.close(second.id, { reason: "close", values: {} });
  assert.deepEqual(manager.visibleStack("mobile").map((item) => item.id), [first.id]);
});

test("open resolves with close payload", async () => {
  const manager = createWindowManager();
  const resultPromise = manager.open({ kind: "dialog", title: "Closable", size: "sm" });
  const opened = manager.snapshot().at(-1);

  assert.ok(opened);
  manager.close(opened!.id, { reason: "close", values: { confirmed: false } });

  await assert.doesNotReject(resultPromise);
  assert.deepEqual(await resultPromise, { reason: "close", values: { confirmed: false } });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/webui/windows/window-manager.test.ts`
Expected: FAIL，报 `Cannot find module ...windowManager.ts` 或 `createWindowManager is not a function`

- [ ] **Step 3: 写最小类型定义**

```ts
import type { Component } from "vue";

export type WindowSize = "auto" | "sm" | "md" | "lg" | "xl" | "full";
export type WindowKind = "dialog" | "panel" | "child-dialog";

export type DialogSchema<TValues> = {
  fields: DialogField<TValues>[];
};

export type DialogField<TValues> =
  | { kind: "string"; key: keyof TValues & string; label: string; defaultValue?: string }
  | { kind: "textarea"; key: keyof TValues & string; label: string; defaultValue?: string }
  | { kind: "number"; key: keyof TValues & string; label: string; defaultValue?: number }
  | { kind: "boolean"; key: keyof TValues & string; label: string; defaultValue?: boolean }
  | { kind: "enum"; key: keyof TValues & string; label: string; defaultValue?: string; options: Array<{ label: string; value: string }> }
  | { kind: "group"; key: keyof TValues & string; label: string; fields: DialogField<Record<string, unknown>>[] }
  | { kind: "custom"; key: keyof TValues & string; label?: string; component: Component };

export type DialogBlock<TValues> =
  | { kind: "text"; content: string }
  | { kind: "separator" }
  | { kind: "component"; component: Component; props?: Record<string, unknown> };

export type DialogAction<TValues, TResult> = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  closeAfterResolve?: boolean;
  run?: (context: { values: TValues; windowId: string }) => Promise<TResult> | TResult;
};

export type WindowDefinition<TValues = Record<string, unknown>, TResult = unknown> = {
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

export type WindowResult<TResult, TValues> =
  | { reason: "action"; actionId: string; values: TValues; result?: TResult }
  | { reason: "close"; values: TValues }
  | { reason: "dismiss"; values: TValues };
```

- [ ] **Step 4: 写最小窗口管理器实现**

```ts
import { shallowRef } from "vue";
import type { WindowDefinition, WindowResult } from "@/components/workbench/windows/types";

type RuntimeWindow = {
  id: string;
  order: number;
  parentId?: string;
  position: { x: number; y: number };
  definition: WindowDefinition;
};

export function createWindowManager() {
  const windows = shallowRef<RuntimeWindow[]>([]);
  const resolvers = new Map<string, (result: WindowResult<unknown, Record<string, unknown>>) => void>();
  let nextOrder = 1;

  function openSync(definition: WindowDefinition) {
    const runtimeWindow: RuntimeWindow = {
      id: definition.id ?? `window-${nextOrder}`,
      order: nextOrder++,
      parentId: definition.parentId,
      position: { x: 0, y: 0 },
      definition
    };
    windows.value = [...windows.value, runtimeWindow];
    enforceFamilyOrdering(runtimeWindow.id);
    return runtimeWindow;
  }

  function open(definition: WindowDefinition) {
    const runtimeWindow = openSync(definition);
    return new Promise<WindowResult<unknown, Record<string, unknown>>>((resolve) => {
      resolvers.set(runtimeWindow.id, resolve);
    });
  }

  function enforceFamilyOrdering(windowId: string) {
    const target = windows.value.find((item) => item.id === windowId);
    if (!target) return;
    const family = windows.value.filter((item) => item.id === target.id || item.parentId === target.id || isAncestorOf(target.id, item.id));
    const rest = windows.value.filter((item) => !family.includes(item));
    family.sort((left, right) => depth(left.id) - depth(right.id));
    windows.value = [...rest, ...family];
  }

  function depth(windowId: string) {
    let current = windows.value.find((item) => item.id === windowId);
    let count = 0;
    while (current?.parentId) {
      count += 1;
      current = windows.value.find((item) => item.id === current?.parentId);
    }
    return count;
  }

  function isAncestorOf(ancestorId: string, windowId: string) {
    let current = windows.value.find((item) => item.id === windowId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) return true;
      current = windows.value.find((item) => item.id === current?.parentId);
    }
    return false;
  }

  return {
    windows,
    open,
    openSync,
    focus: enforceFamilyOrdering,
    move(windowId: string, position: { x: number; y: number }) {
      windows.value = windows.value.map((item) => item.id === windowId ? { ...item, position } : item);
    },
    close(windowId: string, result: WindowResult<unknown, Record<string, unknown>>) {
      windows.value = windows.value.filter((item) => item.id !== windowId);
      resolvers.get(windowId)?.(result);
      resolvers.delete(windowId);
    },
    get(windowId: string) {
      return windows.value.find((item) => item.id === windowId);
    },
    snapshot() {
      return windows.value.slice();
    },
    visibleStack(mode: "desktop" | "mobile") {
      return mode === "mobile" ? windows.value.slice(-1) : windows.value.slice();
    }
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/webui/windows/window-manager.test.ts`
Expected: PASS，3 个测试全部通过

- [ ] **Step 6: 提交**

```bash
git add test/webui/windows/window-manager.test.ts webui/src/components/workbench/windows/types.ts webui/src/composables/workbench/windowManager.ts
git commit -m "feat: add workbench window manager primitives"
```

### Task 2: 建立 WindowHost / WindowSurface 并接入 WorkbenchShell

**Files:**
- Create: `webui/src/components/workbench/windows/windowSizing.ts`
- Create: `webui/src/components/workbench/windows/WindowSurface.vue`
- Create: `webui/src/components/workbench/windows/WindowHost.vue`
- Create: `webui/src/composables/workbench/useWorkbenchWindows.ts`
- Modify: `webui/src/components/workbench/WorkbenchShell.vue`
- Test: `test/webui/windows/window-host.test.tsx`

- [ ] **Step 1: 写失败的宿主组件测试**

```tsx
import test from "node:test";
import assert from "node:assert/strict";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import WindowHost from "../../../webui/src/components/workbench/windows/WindowHost.vue";
import { createWindowManager } from "../../../webui/src/composables/workbench/windowManager.ts";

test("desktop host renders all windows and keeps child above parent", async () => {
  const manager = createWindowManager();
  const parent = manager.openSync({ kind: "dialog", title: "Parent", size: "md", movable: true });
  manager.openSync({ kind: "child-dialog", title: "Child", size: "sm", parentId: parent.id });

  const wrapper = mount(WindowHost, { props: { manager, isMobile: false } });
  await nextTick();

  const titles = wrapper.findAll("[data-window-title]").map((item) => item.text());
  assert.deepEqual(titles, ["Parent", "Child"]);
});

test("mobile host only renders top window", async () => {
  const manager = createWindowManager();
  manager.openSync({ kind: "dialog", title: "First", size: "md" });
  manager.openSync({ kind: "dialog", title: "Second", size: "md" });

  const wrapper = mount(WindowHost, { props: { manager, isMobile: true } });
  await nextTick();

  const titles = wrapper.findAll("[data-window-title]").map((item) => item.text());
  assert.deepEqual(titles, ["Second"]);
});

test("parent surface becomes visually inactive while a child is open", async () => {
  const manager = createWindowManager();
  const parent = manager.openSync({ kind: "dialog", title: "Parent", size: "md", movable: true });
  manager.openSync({ kind: "child-dialog", title: "Child", size: "sm", parentId: parent.id });

  const wrapper = mount(WindowHost, { props: { manager, isMobile: false } });
  await nextTick();

  const parentSurface = wrapper.find(`[data-window-id="${parent.id}"]`);
  assert.match(parentSurface.attributes("class") ?? "", /window-inactive/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test test/webui/windows/window-host.test.tsx`
Expected: FAIL，缺少 `WindowHost.vue` / `useWorkbenchWindows.ts`

- [ ] **Step 3: 写尺寸映射与窗口 API**

```ts
// webui/src/components/workbench/windows/windowSizing.ts
import type { WindowSize } from "./types";

export function resolveWindowSizing(size: WindowSize, isMobile: boolean) {
  if (size === "full") {
    return {
      panelClass: "h-full w-full max-w-none",
      style: {
        width: "min(100%, calc(100vw - 2rem - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)))",
        height: "calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))"
      }
    };
  }

  if (isMobile) {
    return { panelClass: "w-full max-w-lg", style: {} };
  }

  return {
    panelClass: {
      auto: "w-auto max-w-[min(42rem,calc(100vw-2rem))]",
      sm: "w-full max-w-sm",
      md: "w-full max-w-lg",
      lg: "w-full max-w-2xl",
      xl: "w-full max-w-4xl"
    }[size],
    style: {}
  };
}
```

```ts
// webui/src/composables/workbench/useWorkbenchWindows.ts
import { createWindowManager } from "./windowManager";

const sharedWindowManager = createWindowManager();

export function useWorkbenchWindows() {
  return sharedWindowManager;
}
```

- [ ] **Step 4: 写宿主与窗口外壳**

```vue
<!-- webui/src/components/workbench/windows/WindowHost.vue -->
<script setup lang="ts">
import { computed } from "vue";
import WindowSurface from "./WindowSurface.vue";

const props = defineProps<{
  manager: ReturnType<typeof import("@/composables/workbench/windowManager").createWindowManager>;
  isMobile: boolean;
}>();

const visibleWindows = computed(() => props.manager.visibleStack(props.isMobile ? "mobile" : "desktop"));
</script>

<template>
  <div class="pointer-events-none absolute inset-0 z-40">
    <WindowSurface
      v-for="windowItem in visibleWindows"
      :key="windowItem.id"
      :window-item="windowItem"
      :manager="manager"
      :is-mobile="isMobile"
    />
  </div>
</template>
```

```vue
<!-- webui/src/components/workbench/windows/WindowSurface.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { resolveWindowSizing } from "./windowSizing";

const props = defineProps<{
  windowItem: { id: string; title?: string; definition: { title: string; size: import("./types").WindowSize; movable?: boolean }; parentId?: string; position: { x: number; y: number } };
  manager: ReturnType<typeof import("@/composables/workbench/windowManager").createWindowManager>;
  isMobile: boolean;
}>();

const hasChild = computed(() => props.manager.snapshot().some((item) => item.parentId === props.windowItem.id));
const sizing = computed(() => resolveWindowSizing(props.windowItem.definition.size, props.isMobile));
</script>

<template>
  <section
    class="pointer-events-auto fixed inset-x-0 top-4 mx-auto flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden border border-border-strong bg-surface-panel shadow-[0_22px_70px_rgba(0,0,0,0.45)]"
    :class="[sizing.panelClass, hasChild ? 'window-inactive brightness-[0.82] contrast-[0.9]' : '']"
    :style="[{ transform: isMobile ? undefined : `translate(${windowItem.position.x}px, ${windowItem.position.y}px)` }, sizing.style]"
    :data-window-id="windowItem.id"
  >
    <header class="flex items-center gap-3 border-b border-border-default bg-surface-sidebar px-4 py-3">
      <div class="min-w-0 flex-1 truncate text-ui font-medium text-text-secondary" data-window-title>{{ windowItem.definition.title }}</div>
      <button class="btn-ghost -mr-1" @click="manager.close(windowItem.id, { reason: 'close', values: {} })">关闭</button>
    </header>
    <div class="min-h-0 flex-1" :class="hasChild ? 'pointer-events-none' : ''">
      <slot />
    </div>
  </section>
</template>
```

- [ ] **Step 5: 在 WorkbenchShell 挂载 WindowHost**

```vue
<script setup lang="ts">
import WindowHost from "@/components/workbench/windows/WindowHost.vue";
import { useWorkbenchWindows } from "@/composables/workbench/useWorkbenchWindows";
// ...
const windows = useWorkbenchWindows();
</script>

<template>
  <div class="flex h-full w-full overflow-hidden bg-surface-app text-text-primary" :class="ui.isMobile ? 'fixed inset-0' : 'relative pt-safe'">
    <!-- existing shell content -->
    <WindowHost :manager="windows" :is-mobile="ui.isMobile" />
  </div>
</template>
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx tsx --test test/webui/windows/window-host.test.tsx`
Expected: PASS，3 个测试通过

- [ ] **Step 7: 提交**

```bash
git add test/webui/windows/window-host.test.tsx webui/src/components/workbench/windows/windowSizing.ts webui/src/components/workbench/windows/WindowSurface.vue webui/src/components/workbench/windows/WindowHost.vue webui/src/composables/workbench/useWorkbenchWindows.ts webui/src/components/workbench/WorkbenchShell.vue
git commit -m "feat: add workbench window host and surface"
```

### Task 3: 建立 DialogRenderer 与声明式 DSL

**Files:**
- Create: `webui/src/components/workbench/windows/DialogRenderer.vue`
- Modify: `webui/src/components/workbench/windows/types.ts`
- Test: `test/webui/windows/dialog-renderer.test.tsx`

- [ ] **Step 1: 写失败的渲染器测试**

```tsx
import test from "node:test";
import assert from "node:assert/strict";
import { mount } from "@vue/test-utils";
import DialogRenderer from "../../../webui/src/components/workbench/windows/DialogRenderer.vue";

test("action callbacks receive complete form values", async () => {
  let received: Record<string, unknown> | undefined;

  const wrapper = mount(DialogRenderer, {
    props: {
      windowId: "dialog-1",
      schema: {
        fields: [
          { kind: "string", key: "title", label: "标题", defaultValue: "默认标题" },
          { kind: "boolean", key: "pinned", label: "置顶", defaultValue: true }
        ]
      },
      actions: [
        {
          id: "submit",
          label: "提交",
          run: ({ values }: { values: Record<string, unknown> }) => {
            received = values;
          }
        }
      ]
    }
  });

  await wrapper.find('input[name="title"]').setValue("新标题");
  await wrapper.find('button[data-action-id="submit"]').trigger("click");

  assert.deepEqual(received, { title: "新标题", pinned: true });
});

test("close and dismiss emit full values", async () => {
  const emitted: Array<Record<string, unknown>> = [];

  const wrapper = mount(DialogRenderer, {
    props: {
      windowId: "dialog-2",
      schema: { fields: [{ kind: "string", key: "name", label: "名称", defaultValue: "alpha" }] },
      actions: []
    },
    attrs: {
      onResolve: (payload: Record<string, unknown>) => emitted.push(payload)
    }
  });

  await wrapper.find('input[name="name"]').setValue("beta");
  await wrapper.vm.$emit("resolve", { reason: "close", values: { name: "beta" } });

  assert.deepEqual(emitted, [{ reason: "close", values: { name: "beta" } }]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test test/webui/windows/dialog-renderer.test.tsx`
Expected: FAIL，缺少 `DialogRenderer.vue`

- [ ] **Step 3: 扩充字段类型中需要的可选属性**

```ts
export type DialogField<TValues> =
  | { kind: "string"; key: keyof TValues & string; label: string; defaultValue?: string; required?: boolean; placeholder?: string }
  | { kind: "textarea"; key: keyof TValues & string; label: string; defaultValue?: string; placeholder?: string }
  | { kind: "number"; key: keyof TValues & string; label: string; defaultValue?: number; min?: number; max?: number }
  | { kind: "boolean"; key: keyof TValues & string; label: string; defaultValue?: boolean }
  | { kind: "enum"; key: keyof TValues & string; label: string; defaultValue?: string; options: Array<{ label: string; value: string }> }
  | { kind: "group"; key: keyof TValues & string; label: string; fields: DialogField<Record<string, unknown>>[] }
  | { kind: "custom"; key: keyof TValues & string; label?: string; component: Component; props?: Record<string, unknown> };
```

- [ ] **Step 4: 写最小渲染器实现**

```vue
<script setup lang="ts">
import { computed, reactive } from "vue";
import type { DialogAction, DialogBlock, DialogSchema, WindowResult } from "./types";

const props = defineProps<{
  windowId: string;
  schema?: DialogSchema<Record<string, unknown>>;
  blocks?: DialogBlock<Record<string, unknown>>[];
  actions?: DialogAction<Record<string, unknown>, unknown>[];
}>();

const emit = defineEmits<{
  resolve: [payload: WindowResult<unknown, Record<string, unknown>>];
}>();

const values = reactive<Record<string, unknown>>(
  Object.fromEntries((props.schema?.fields ?? []).map((field) => [field.key, "defaultValue" in field ? field.defaultValue : undefined]))
);

async function runAction(action: DialogAction<Record<string, unknown>, unknown>) {
  const result = await action.run?.({ values: { ...values }, windowId: props.windowId });
  emit("resolve", { reason: "action", actionId: action.id, values: { ...values }, result });
}

const fields = computed(() => props.schema?.fields ?? []);
const blocks = computed(() => props.blocks ?? []);
const actions = computed(() => props.actions ?? []);
</script>

<template>
  <div class="flex flex-col gap-4 px-4 py-4">
    <template v-for="block in blocks" :key="block.kind + String(block.content ?? block.component)">
      <p v-if="block.kind === 'text'" class="text-small leading-5 text-text-muted">{{ block.content }}</p>
      <div v-else-if="block.kind === 'separator'" class="border-t border-border-default" />
      <component :is="block.component" v-else :="block.props ?? {}" />
    </template>

    <template v-for="field in fields" :key="field.key">
      <label v-if="field.kind === 'string'" class="flex flex-col gap-1.5 text-small text-text-muted">
        {{ field.label }}
        <input :name="field.key" class="input-base text-ui" :placeholder="field.placeholder" :value="values[field.key] as string ?? ''" @input="values[field.key] = ($event.target as HTMLInputElement).value" />
      </label>

      <label v-else-if="field.kind === 'boolean'" class="flex items-center gap-2 text-small text-text-muted">
        <input :name="field.key" type="checkbox" :checked="Boolean(values[field.key])" @change="values[field.key] = ($event.target as HTMLInputElement).checked" />
        <span>{{ field.label }}</span>
      </label>
    </template>

    <div v-if="actions.length" class="flex items-center justify-end gap-2 border-t border-border-default pt-3">
      <button v-for="action in actions" :key="action.id" class="btn" :data-action-id="action.id" @click="runAction(action)">{{ action.label }}</button>
    </div>
  </div>
</template>
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx --test test/webui/windows/dialog-renderer.test.tsx`
Expected: PASS，动作回调和结果 payload 都拿到完整值

- [ ] **Step 6: 提交**

```bash
git add test/webui/windows/dialog-renderer.test.tsx webui/src/components/workbench/windows/DialogRenderer.vue webui/src/components/workbench/windows/types.ts
git commit -m "feat: add declarative dialog renderer"
```

### Task 4: 建立 SchemaMeta 适配器

**Files:**
- Create: `webui/src/components/workbench/windows/dialogSchemaAdapter.ts`
- Test: `test/webui/windows/schema-meta-adapter.test.ts`

- [ ] **Step 1: 写失败的适配器测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { s } from "../../../src/data/schema/index.ts";
import { schemaMetaToDialogFields } from "../../../webui/src/components/workbench/windows/dialogSchemaAdapter.ts";

test("schemaMetaToDialogFields converts supported scalar fields", () => {
  const meta = s.object({
    title: s.string().label("标题"),
    pinned: s.boolean().label("置顶"),
    mode: s.enum(["chat", "agent"]).label("模式")
  }).meta;

  const fields = schemaMetaToDialogFields(meta);
  assert.deepEqual(fields.map((field) => field.kind), ["group"]);
});

test("schemaMetaToDialogFields rejects unsupported record fields", () => {
  const meta = s.record(s.string()).meta;
  assert.throws(() => schemaMetaToDialogFields(meta), /unsupported schema meta/i);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/webui/windows/schema-meta-adapter.test.ts`
Expected: FAIL，缺少 `dialogSchemaAdapter.ts`

- [ ] **Step 3: 写受限适配器**

```ts
import type { DialogField } from "./types";
import type { SchemaMeta } from "../../../../src/data/schema/index.ts";

export function schemaMetaToDialogFields(meta: SchemaMeta): DialogField<Record<string, unknown>>[] {
  if (meta.kind === "object") {
    return [{
      kind: "group",
      key: meta.key ?? "root",
      label: meta.label ?? "表单",
      fields: Object.entries(meta.shape).flatMap(([key, child]) => convertField(key, child))
    }];
  }
  throw new Error(`Unsupported schema meta root kind: ${meta.kind}`);
}

function convertField(key: string, meta: SchemaMeta): DialogField<Record<string, unknown>>[] {
  switch (meta.kind) {
    case "string":
      return [{ kind: "string", key, label: meta.label ?? key }];
    case "number":
      return [{ kind: "number", key, label: meta.label ?? key }];
    case "boolean":
      return [{ kind: "boolean", key, label: meta.label ?? key }];
    case "enum":
      return [{ kind: "enum", key, label: meta.label ?? key, options: meta.options.map((item) => ({ label: String(item), value: String(item) })) }];
    default:
      throw new Error(`Unsupported schema meta kind: ${meta.kind}`);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/webui/windows/schema-meta-adapter.test.ts`
Expected: PASS，支持字段被转换，不支持字段抛错

- [ ] **Step 5: 提交**

```bash
git add test/webui/windows/schema-meta-adapter.test.ts webui/src/components/workbench/windows/dialogSchemaAdapter.ts
git commit -m "feat: add schema meta adapter for dialog fields"
```

### Task 5: 把 WorkbenchDialog 改成兼容桥接层

**Files:**
- Modify: `webui/src/components/common/WorkbenchDialog.vue`
- Test: `test/webui/windows/workbench-dialog-source.test.ts`

- [ ] **Step 1: 写失败的 source test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("WorkbenchDialog no longer teleports directly to body", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/common/WorkbenchDialog.vue", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /<teleport to="body">/);
  assert.match(source, /useWorkbenchWindows/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/webui/windows/workbench-dialog-source.test.ts`
Expected: FAIL，当前源码仍含 `<teleport to="body">`

- [ ] **Step 3: 写兼容桥接层**

```vue
<script setup lang="ts">
import { computed, watch } from "vue";
import { useWorkbenchWindows } from "@/composables/workbench/useWorkbenchWindows";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description?: string;
  variant?: "content" | "fullscreen";
  widthClass?: string;
  panelClass?: string;
  bodyClass?: string;
  closeOnBackdrop?: boolean;
}>(), {
  description: undefined,
  variant: "content",
  widthClass: "max-w-lg",
  panelClass: "",
  bodyClass: "",
  closeOnBackdrop: true
});

const emit = defineEmits<{ close: [] }>();
const windows = useWorkbenchWindows();
let activeWindowId: string | null = null;

const size = computed(() => props.variant === "fullscreen" ? "full" : "md");

watch(() => props.open, (open) => {
  if (open && !activeWindowId) {
    const runtimeWindow = windows.openSync({
      kind: "dialog",
      title: props.title,
      description: props.description,
      size: size.value,
      closeOnBackdrop: props.closeOnBackdrop
    });
    activeWindowId = runtimeWindow.id;
    return;
  }

  if (!open && activeWindowId) {
    windows.close(activeWindowId, { reason: "close", values: {} });
    activeWindowId = null;
  }
}, { immediate: true });
</script>

<template>
  <div class="hidden">
    <slot />
    <slot name="footer" />
  </div>
</template>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/webui/windows/workbench-dialog-source.test.ts`
Expected: PASS，兼容层不再直接 teleport

- [ ] **Step 5: 提交**

```bash
git add test/webui/windows/workbench-dialog-source.test.ts webui/src/components/common/WorkbenchDialog.vue
git commit -m "refactor: bridge workbench dialog to window host"
```

### Task 6: 迁移 CreateSessionDialog / ImagePreviewDialog / 会话操作窗口

**Files:**
- Modify: `webui/src/components/sessions/CreateSessionDialog.vue`
- Modify: `webui/src/components/common/ImagePreviewDialog.vue`
- Modify: `webui/src/components/sessions/ChatPanel.vue`
- Modify: `webui/src/sections/sessions/SessionsListPane.vue`
- Modify: `webui/src/sections/workspace/WorkspaceMainPane.vue`
- Modify: `test/webui/layout/section-migration-source.test.ts`
- Test: `test/webui/create-session-dialog.test.ts`
- Test: `test/webui/windows/window-host.test.tsx`
- Test: `test/webui/windows/dialog-renderer.test.tsx`

- [ ] **Step 1: 写/更新失败测试，约束迁移方向**

```ts
// test/webui/layout/section-migration-source.test.ts
assert.doesNotMatch(listPaneSource, /<WorkbenchDialog/);
assert.doesNotMatch(mainPaneSource, /ImagePreviewDialog/);
assert.match(listPaneSource, /useWorkbenchWindows/);
assert.match(mainPaneSource, /useWorkbenchWindows/);
```

```ts
// test/webui/create-session-dialog.test.ts
assert.match(source, /useWorkbenchWindows/);
assert.match(source, /schema:/);
assert.match(source, /actions:/);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/webui/layout/section-migration-source.test.ts test/webui/create-session-dialog.test.ts`
Expected: FAIL，旧组件仍直接引用 `WorkbenchDialog` / `ImagePreviewDialog`

- [ ] **Step 3: 用窗口定义迁移创建会话与图片预览**

```ts
// CreateSessionDialog.vue (核心方向)
const windows = useWorkbenchWindows();

async function openCreateSessionDialog() {
  return windows.open({
    kind: "dialog",
    title: "新建会话",
    description: "创建一个 owner Web 会话。这个表单只保留展示与模式字段。",
    size: "lg",
    schema: {
      fields: [
        { kind: "string", key: "title", label: "显示名称", placeholder: titlePlaceholder.value, defaultValue: "" },
        {
          kind: "enum",
          key: "modeId",
          label: "会话模式",
          defaultValue: modeId.value,
          options: (props.modes ?? []).map((mode) => ({ label: mode.title, value: mode.id }))
        }
      ]
    },
    blocks: [
      { kind: "text", content: "当前会创建一个绑定到 `owner` 的 `web:*` 私聊会话，并使用所选 mode。" }
    ],
    actions: [
      { id: "cancel", label: "取消", variant: "secondary", closeAfterResolve: true },
      {
        id: "submit",
        label: props.busy ? "创建中…" : "创建会话",
        variant: "primary",
        closeAfterResolve: true,
        run: ({ values }) => buildCreateSessionPayload({
          title: String(values.title ?? ""),
          modeId: String(values.modeId ?? "")
        })
      }
    ]
  });
}
```

```ts
// WorkspaceMainPane.vue / ChatPanel.vue
const windows = useWorkbenchWindows();

function openImagePreview(src: string, alt?: string, title?: string) {
  return windows.open({
    kind: "dialog",
    title: title || alt || "图片预览",
    size: "full",
    blocks: [{ kind: "component", component: ImagePreviewBlock, props: { src, alt, title } }],
    actions: [{ id: "close", label: "关闭", variant: "secondary", closeAfterResolve: true }]
  });
}
```

- [ ] **Step 4: 迁移会话操作窗口为子窗口/动作窗口**

```ts
const result = await windows.open({
  kind: "child-dialog",
  parentId: sessionDetailsWindowId,
  title: "会话操作",
  size: "sm",
  blocks: [{ kind: "text", content: `将对会话 ${sessionId} 执行操作。` }],
  actions: [
    { id: "rename", label: "重命名", variant: "secondary", closeAfterResolve: true, run: () => ({ intent: "rename" }) },
    { id: "delete", label: "删除", variant: "danger", closeAfterResolve: true, run: () => ({ intent: "delete" }) }
  ]
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/webui/layout/section-migration-source.test.ts test/webui/create-session-dialog.test.ts`
Expected: PASS，source test 改为约束窗口系统调用

Run: `npx tsx --test test/webui/windows/window-host.test.tsx test/webui/windows/dialog-renderer.test.tsx`
Expected: PASS，迁移未破坏低层行为

- [ ] **Step 6: 提交**

```bash
git add test/webui/layout/section-migration-source.test.ts test/webui/create-session-dialog.test.ts webui/src/components/sessions/CreateSessionDialog.vue webui/src/components/common/ImagePreviewDialog.vue webui/src/components/sessions/ChatPanel.vue webui/src/sections/sessions/SessionsListPane.vue webui/src/sections/workspace/WorkspaceMainPane.vue
git commit -m "refactor: migrate dialogs to unified window system"
```

### Task 7: 运行回归并收尾文档

**Files:**
- Modify: `docs/superpowers/specs/2026-04-21-webui-window-system-design.md`（仅在实现中发现 spec 需微调时）
- Modify: `docs/superpowers/plans/2026-04-21-webui-window-system-task1.md`（勾选执行状态时可选）

- [ ] **Step 1: 运行任务相关测试集合**

Run: `node --test test/webui/windows/window-manager.test.ts test/webui/windows/schema-meta-adapter.test.ts test/webui/windows/workbench-dialog-source.test.ts test/webui/layout/section-migration-source.test.ts test/webui/create-session-dialog.test.ts`
Expected: PASS

Run: `npx tsx --test test/webui/windows/window-host.test.tsx test/webui/windows/dialog-renderer.test.tsx test/webui/layout/app-layout.test.tsx`
Expected: PASS

- [ ] **Step 2: 运行仓库级强制校验**

Run: `npm run typecheck:all`
Expected: PASS

Run: `npm run test`
Expected: PASS

- [ ] **Step 3: 提交最终收尾**

```bash
git add .
git commit -m "test: verify unified window system rollout"
```

---

## 自检

### Spec 覆盖检查

- 全局窗口管理器：Task 1、Task 2
- 桌面拖拽/置顶/父子层级约束：Task 1、Task 2
- 移动端只显示栈顶：Task 1、Task 2
- `size` 语义：Task 2
- `DialogSchema` / `DialogAction` / `DialogBlock`：Task 3
- 按钮和关闭路径返回完整表单值：Task 3
- `SchemaMeta` 受限适配器：Task 4
- `WorkbenchDialog` 降级为兼容层：Task 5
- 迁移创建会话/图片预览/会话操作窗口：Task 6
- 最终回归与仓库级验证：Task 7

### Placeholder 扫描

- 没有保留 `TODO` / `TBD` / “类似 Task N” 这种空指令
- 每个任务都给了明确文件、测试、命令和提交切片

### 类型一致性

- `WindowSize` 在任务中统一为 `auto | sm | md | lg | xl | full`
- `WindowDefinition` / `WindowResult` / `DialogSchema` / `DialogAction` 命名在各任务保持一致
- 父子层级约束在 Task 1 逻辑测试与 Task 2 组件测试中都有对应验证

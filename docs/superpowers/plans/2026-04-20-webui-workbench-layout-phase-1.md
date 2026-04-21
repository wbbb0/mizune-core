# WebUI Workbench Layout Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `Config / Data / Settings` 从“页面拥有完整布局”迁移到“section 向统一 workbench 注册区域内容”的第一阶段骨架上，同时预留 `topbar / auxPane / statusbar / mobile menus` 的最终 contract。

**Architecture:** 新增 `WorkbenchShell + SectionHost + WorkbenchRegistry + WorkbenchRuntime` 四件套，页面只保留 `section-id` 入口。第一阶段只完整实现 `nav / listPane / mainPane / mobileHeader / mobileMainFlow`，但 section contract 一次性包含未来全部区域，避免后续再改接口形状。

**Tech Stack:** Vue 3、Vue Router、Pinia、TypeScript、Tailwind CSS、Node `node:test`

## Phase 1 Completion Notes

- `ConfigPage`、`DataPage`、`SettingsPage` 已全部改成 `<SectionHost section-id="...">`
- `useConfigSection()`、`useDataSection()`、`useSettingsSection()` 已承接各自页面的共享 section 状态
- `webui/src/sections/registry.ts` 当前对 `config / data / settings` 使用真实 section，其余 section 仍走 placeholder
- `SessionsPage`、`WorkspacePage` 仍保留旧布局，作为下一阶段迁移对象
- 布局 contract 已预留 `topbar / auxPane / statusbar / mobileTopMenu / mobileBottomMenu`，本阶段未启用真实内容

---

## File Structure

### New files

- `webui/src/components/workbench/SectionHost.vue`
  - 读取 `section-id`，从 registry 中解析 section，并把它交给 `WorkbenchShell`
- `webui/src/components/workbench/WorkbenchShell.vue`
  - 统一承接全局导航、桌面/移动端布局、`list/main` 切换和移动端 header
- `webui/src/composables/workbench/useWorkbenchRegistry.ts`
  - 定义 `WorkbenchSection` 类型和 registry 访问 helper
- `webui/src/composables/workbench/useWorkbenchRuntime.ts`
  - 提供 `showList()` / `showMain()` 等运行时 API
- `webui/src/sections/registry.ts`
  - 汇总所有 section 注册对象
- `webui/src/sections/config/index.ts`
- `webui/src/composables/sections/useConfigSection.ts`
- `webui/src/sections/config/ConfigListPane.vue`
- `webui/src/sections/config/ConfigMainPane.vue`
- `webui/src/sections/config/ConfigMobileHeader.vue`
- `webui/src/sections/data/index.ts`
- `webui/src/composables/sections/useDataSection.ts`
- `webui/src/sections/data/DataListPane.vue`
- `webui/src/sections/data/DataMainPane.vue`
- `webui/src/sections/data/DataMobileHeader.vue`
- `webui/src/sections/settings/index.ts`
- `webui/src/composables/sections/useSettingsSection.ts`
- `webui/src/sections/settings/SettingsListPane.vue`
- `webui/src/sections/settings/SettingsMainPane.vue`
- `webui/src/sections/settings/SettingsMobileHeader.vue`
- `test/webui/layout/workbench-registry-source.test.ts`
  - 验证 contract 中包含未来区域和最小运行时 API
- `test/webui/layout/section-host-source.test.ts`
  - 验证 page -> section host -> shell 的薄入口形态
- `test/webui/layout/section-migration-source.test.ts`
  - 验证 `Config / Data / Settings` 已改为 section 注册内容

### Modified files

- `webui/src/router.ts`
  - 保持现有 route name，但让 page 变薄后仍维持原路由语义
- `webui/src/components/layout/ActivityBar.vue`
  - 抽出导航项元数据常量或让 shell 直接复用，避免页面自行拥有工作台导航
- `webui/src/pages/ConfigPage.vue`
- `webui/src/pages/DataPage.vue`
- `webui/src/pages/SettingsPage.vue`
  - 改为 `<SectionHost section-id="...">`
- `test/webui/layout/app-layout.test.tsx`
  - 退役为 `WorkbenchShell` 相关断言，或保留一条兼容 safe-area 断言并增加 shell 断言

### Existing files intentionally left alone in phase 1

- `webui/src/pages/SessionsPage.vue`
- `webui/src/pages/WorkspacePage.vue`
- `webui/src/components/sessions/ChatPanel.vue`
- `webui/src/components/sessions/SessionStatePanel.vue`
- 所有 bot/runtime/backend 源码

### Baseline risks to preserve explicitly

- worktree 当前 `npm run typecheck:all` 已有前端依赖/类型基线失败
- worktree 当前 `npm run test` 已有 `test/webui/app/toast.test.ts` 失败
- 本计划不把这些基线失败与布局重构耦合；实现阶段只能确保不新增同类失败，并在最终汇报中明确残留基线问题

## Task 1: Establish Workbench Contracts

**Files:**
- Create: `webui/src/composables/workbench/useWorkbenchRegistry.ts`
- Create: `webui/src/composables/workbench/useWorkbenchRuntime.ts`
- Create: `test/webui/layout/workbench-registry-source.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("workbench section contract reserves future regions while phase 1 uses minimal panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/composables/workbench/useWorkbenchRegistry.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /type WorkbenchSection = \{/);
  assert.match(source, /listPane\?: Component/);
  assert.match(source, /mainPane: Component/);
  assert.match(source, /auxPane\?: Component/);
  assert.match(source, /topbar\?: Component/);
  assert.match(source, /statusbar\?: Component/);
  assert.match(source, /mobileTopMenu\?: Component/);
  assert.match(source, /mobileBottomMenu\?: Component/);
  assert.match(source, /mobileMainFlow: "list-main" \| "main-only"/);
});

test("workbench runtime exposes shell-controlled mobile navigation primitives", async () => {
  const source = await readFile(
    new URL("../../../webui/src/composables/workbench/useWorkbenchRuntime.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /mobileScreen = ref<"list" \| "main">/);
  assert.match(source, /function showList\(\)/);
  assert.match(source, /function showMain\(\)/);
  assert.match(source, /function openAux\(\)/);
  assert.match(source, /function closeAux\(\)/);
  assert.match(source, /function toggleTopMenu\(\)/);
  assert.match(source, /function toggleBottomMenu\(\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/webui/layout/workbench-registry-source.test.ts`
Expected: FAIL with `ENOENT` because the new workbench contract files do not exist yet.

- [ ] **Step 3: Write minimal registry and runtime implementations**

```ts
// webui/src/composables/workbench/useWorkbenchRegistry.ts
import { computed, type Component } from "vue";
import { workbenchSections } from "@/sections/registry";

export type WorkbenchSection = {
  id: string;
  title: string;
  icon?: Component;
  routeName: string;
  regions: {
    listPane?: Component;
    mainPane: Component;
    auxPane?: Component;
    topbar?: Component;
    statusbar?: Component;
    mobileHeader?: Component;
    mobileTopMenu?: Component;
    mobileBottomMenu?: Component;
  };
  layout: {
    mobileMainFlow: "list-main" | "main-only";
    auxMode: "inline" | "drawer";
    defaults?: {
      topbar?: boolean;
      auxPane?: boolean;
      statusbar?: boolean;
    };
  };
};

export function useWorkbenchRegistry() {
  const sectionsById = computed(() =>
    new Map(workbenchSections.map((section) => [section.id, section] as const))
  );

  function getSectionById(id: string): WorkbenchSection {
    const section = sectionsById.value.get(id);
    if (!section) {
      throw new Error(`Unknown workbench section: ${id}`);
    }
    return section;
  }

  return {
    workbenchSections,
    sectionsById,
    getSectionById
  };
}
```

```ts
// webui/src/composables/workbench/useWorkbenchRuntime.ts
import { ref } from "vue";

const mobileScreen = ref<"list" | "main">("list");
const auxOpen = ref(false);
const topMenuOpen = ref(false);
const bottomMenuOpen = ref(false);

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

function toggleTopMenu() {
  topMenuOpen.value = !topMenuOpen.value;
}

function toggleBottomMenu() {
  bottomMenuOpen.value = !bottomMenuOpen.value;
}

export function useWorkbenchRuntime() {
  return {
    mobileScreen,
    auxOpen,
    topMenuOpen,
    bottomMenuOpen,
    showList,
    showMain,
    openAux,
    closeAux,
    toggleTopMenu,
    toggleBottomMenu
  };
}
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `node --test test/webui/layout/workbench-registry-source.test.ts`
Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```bash
git add \
  webui/src/composables/workbench/useWorkbenchRegistry.ts \
  webui/src/composables/workbench/useWorkbenchRuntime.ts \
  test/webui/layout/workbench-registry-source.test.ts
git commit -m "feat: add workbench registry and runtime contracts"
```

## Task 2: Add SectionHost and WorkbenchShell

**Files:**
- Create: `webui/src/components/workbench/SectionHost.vue`
- Create: `webui/src/components/workbench/WorkbenchShell.vue`
- Create: `webui/src/sections/registry.ts`
- Modify: `webui/src/components/layout/ActivityBar.vue`
- Create: `test/webui/layout/section-host-source.test.ts`
- Modify: `test/webui/layout/app-layout.test.tsx`

- [ ] **Step 1: Write failing shell and host source tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("section host resolves section ids and delegates rendering to workbench shell", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/workbench/SectionHost.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /defineProps<\{\s*sectionId: string;\s*\}>/);
  assert.match(source, /useWorkbenchRegistry/);
  assert.match(source, /<WorkbenchShell :section="section"/);
});

test("workbench shell owns navigation and mobile list-main switching", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /ActivityBar/);
  assert.match(source, /useWorkbenchRuntime/);
  assert.match(source, /section\.regions\.listPane/);
  assert.match(source, /section\.regions\.mainPane/);
  assert.match(source, /section\.regions\.mobileHeader/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/webui/layout/section-host-source.test.ts`
Expected: FAIL with `ENOENT` because the new shell files do not exist yet.

- [ ] **Step 3: Write minimal shell, host, and registry wiring**

```ts
// webui/src/sections/registry.ts
import type { WorkbenchSection } from "@/composables/workbench/useWorkbenchRegistry";

export const workbenchSections: WorkbenchSection[] = [];
```

```vue
<!-- webui/src/components/workbench/SectionHost.vue -->
<script setup lang="ts">
import { computed } from "vue";
import WorkbenchShell from "./WorkbenchShell.vue";
import { useWorkbenchRegistry } from "@/composables/workbench/useWorkbenchRegistry";

const props = defineProps<{
  sectionId: string;
}>();

const { getSectionById } = useWorkbenchRegistry();
const section = computed(() => getSectionById(props.sectionId));
</script>

<template>
  <WorkbenchShell :section="section" />
</template>
```

```vue
<!-- webui/src/components/workbench/WorkbenchShell.vue -->
<script setup lang="ts">
import { computed } from "vue";
import ActivityBar from "@/components/layout/ActivityBar.vue";
import { useUiStore } from "@/stores/ui";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";
import type { WorkbenchSection } from "@/composables/workbench/useWorkbenchRegistry";

const props = defineProps<{
  section: WorkbenchSection;
}>();

const ui = useUiStore();
const { mobileScreen, showList } = useWorkbenchRuntime();
const listPane = computed(() => props.section.regions.listPane);
const mainPane = computed(() => props.section.regions.mainPane);
const mobileHeader = computed(() => props.section.regions.mobileHeader);
</script>

<template>
  <div class="flex h-full w-full overflow-hidden bg-surface-app text-text-primary" :class="ui.isMobile ? 'fixed inset-0' : 'relative pt-safe'">
    <template v-if="!ui.isMobile">
      <ActivityBar />
      <aside class="scrollbar-thin w-(--side-panel-width) shrink-0 overflow-x-hidden overflow-y-auto border-r border-border-default bg-surface-sidebar">
        <component :is="listPane" v-if="section.regions.listPane" />
      </aside>
      <main class="flex min-w-0 flex-1 flex-col overflow-hidden pr-safe">
        <component :is="mainPane" />
      </main>
    </template>

    <template v-else>
      <div class="absolute inset-0 flex flex-col bg-surface-app">
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden" v-show="mobileScreen === 'list'">
          <component :is="listPane" v-if="section.regions.listPane" />
        </div>
      </div>
      <div class="absolute inset-0 flex flex-col bg-surface-app z-10" :class="mobileScreen === 'main' ? 'translate-x-0' : 'translate-x-full pointer-events-none'">
        <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border-default bg-surface-sidebar px-3">
          <button class="flex cursor-pointer items-center gap-1 border-0 bg-transparent px-0 py-1 text-ui text-accent" @click="showList()">
            <span>返回</span>
          </button>
          <component :is="mobileHeader" v-if="section.regions.mobileHeader" />
        </header>
        <div class="min-h-0 flex-1 overflow-hidden">
          <component :is="mainPane" />
        </div>
      </div>
    </template>
  </div>
</template>
```

```vue
<!-- webui/src/components/layout/ActivityBar.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useRouter, useRoute } from "vue-router";
import { MessageSquare, SlidersHorizontal, Database, Settings, Folder } from "lucide-vue-next";

export const primaryNavItems = [
  { name: "sessions", path: "/sessions", icon: MessageSquare, label: "会话" },
  { name: "config", path: "/config", icon: SlidersHorizontal, label: "配置" },
  { name: "data", path: "/data", icon: Database, label: "数据" },
  { name: "files", path: "/files", icon: Folder, label: "文件" }
] as const;

export const bottomNavItems = [
  { name: "settings", path: "/settings", icon: Settings, label: "设置" }
] as const;

const router = useRouter();
const route = useRoute();
const currentRoute = computed(() => route.name as string);
</script>
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `node --test test/webui/layout/section-host-source.test.ts test/webui/layout/app-layout.test.tsx`
Expected: PASS, and safe-area assertion now points at `WorkbenchShell` rather than the old page-owned layout pattern.

- [ ] **Step 5: Commit**

```bash
git add \
  webui/src/components/workbench/SectionHost.vue \
  webui/src/components/workbench/WorkbenchShell.vue \
  webui/src/sections/registry.ts \
  webui/src/components/layout/ActivityBar.vue \
  test/webui/layout/section-host-source.test.ts \
  test/webui/layout/app-layout.test.tsx
git commit -m "feat: add workbench shell and section host"
```

## Task 3: Migrate Config to a Registered Section

**Files:**
- Create: `webui/src/sections/config/index.ts`
- Create: `webui/src/composables/sections/useConfigSection.ts`
- Create: `webui/src/sections/config/ConfigListPane.vue`
- Create: `webui/src/sections/config/ConfigMainPane.vue`
- Create: `webui/src/sections/config/ConfigMobileHeader.vue`
- Modify: `webui/src/sections/registry.ts`
- Modify: `webui/src/pages/ConfigPage.vue`
- Create: `test/webui/layout/section-migration-source.test.ts`

- [ ] **Step 1: Write the failing migration test for config**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("config page becomes a thin section host entry point", async () => {
  const source = await readFile(
    new URL("../../../webui/src/pages/ConfigPage.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /SectionHost/);
  assert.match(source, /section-id="config"/);
  assert.doesNotMatch(source, /<AppLayout/);
});

test("config section registers list main and mobile header panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/config/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /id: "config"/);
  assert.match(source, /routeName: "config"/);
  assert.match(source, /listPane: ConfigListPane/);
  assert.match(source, /mainPane: ConfigMainPane/);
  assert.match(source, /mobileHeader: ConfigMobileHeader/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/webui/layout/section-migration-source.test.ts`
Expected: FAIL because config section files and thin page host do not exist yet.

- [ ] **Step 3: Split ConfigPage into registered panes**

```ts
// webui/src/sections/config/index.ts
import type { WorkbenchSection } from "@/composables/workbench/useWorkbenchRegistry";
import ConfigListPane from "./ConfigListPane.vue";
import ConfigMainPane from "./ConfigMainPane.vue";
import ConfigMobileHeader from "./ConfigMobileHeader.vue";

export const configSection: WorkbenchSection = {
  id: "config",
  title: "配置",
  routeName: "config",
  regions: {
    listPane: ConfigListPane,
    mainPane: ConfigMainPane,
    mobileHeader: ConfigMobileHeader
  },
  layout: {
    mobileMainFlow: "list-main",
    auxMode: "drawer",
    defaults: {
      topbar: false,
      auxPane: false,
      statusbar: false
    }
  }
};
```

```ts
// webui/src/composables/sections/useConfigSection.ts
import { ref, watch } from "vue";
import { editorApi, type EditorResourceSummary, type EditorModel } from "@/api/editor";
import { useLayeredEditorState } from "@/composables/useLayeredEditorState";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";

const resources = ref<EditorResourceSummary[]>([]);
const selectedKey = ref<string | null>(null);
const model = ref<EditorModel | null>(null);
const loading = ref(false);
const saving = ref(false);
const validating = ref(false);

const editorState = useLayeredEditorState(model);
let resourcesLoaded = false;

async function ensureResourcesLoaded() {
  if (resourcesLoaded) return;
  const res = await editorApi.list();
  resources.value = res.resources.filter((entry) => entry.domain === "config" && entry.editable);
  resourcesLoaded = true;
}

watch(selectedKey, async (key) => {
  if (!key) {
    model.value = null;
    editorState.draftValue.value = null;
    return;
  }
  loading.value = true;
  try {
    const res = await editorApi.load(key);
    model.value = res.editor;
  } finally {
    loading.value = false;
  }
});

export function useConfigSection() {
  const runtime = useWorkbenchRuntime();

  function selectResource(key: string) {
    selectedKey.value = key;
    runtime.showMain();
  }

  return {
    resources,
    selectedKey,
    model,
    loading,
    saving,
    validating,
    selectResource,
    ensureResourcesLoaded,
    ...editorState
  };
}
```

```vue
<!-- webui/src/pages/ConfigPage.vue -->
<script setup lang="ts">
import SectionHost from "@/components/workbench/SectionHost.vue";
</script>

<template>
  <SectionHost section-id="config" />
</template>
```

```vue
<!-- webui/src/sections/config/ConfigListPane.vue -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useConfigSection } from "@/composables/sections/useConfigSection";

const section = useConfigSection();
onMounted(() => {
  void section.ensureResourcesLoaded();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div class="panel-header flex h-10 shrink-0 items-center border-b px-3">
      <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">配置编辑器</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <button
        v-for="resource in section.resources"
        :key="resource.key"
        class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left"
        :class="{ 'is-selected': section.selectedKey === resource.key }"
        @click="section.selectResource(resource.key)"
      >
        <span class="text-ui text-text-secondary">{{ resource.title }}</span>
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ resource.kind }}</span>
      </button>
    </div>
  </div>
</template>
```

```vue
<!-- webui/src/sections/config/ConfigMainPane.vue -->
<script setup lang="ts">
import SchemaNode from "@/components/editor/SchemaNode.vue";
import { useConfigSection } from "@/composables/sections/useConfigSection";

const section = useConfigSection();
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div v-if="!section.selectedKey" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个配置项</div>
    <div v-else-if="section.loading" class="panel-empty flex flex-1 items-center justify-center gap-2">加载中…</div>
    <template v-else-if="section.model">
      <header class="toolbar-header flex min-h-10 shrink-0 flex-wrap items-center gap-2.5 border-b px-4 py-1.5">
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ section.model.kind }}</span>
      </header>
      <div class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
        <SchemaNode
          :node="section.model.uiTree"
          :model-value="section.draftValue"
          :inherited="section.model.kind === 'layered' ? section.baseValue : section.model.current"
          :base-value="section.isLayered ? section.baseValue : undefined"
          :stored-value="section.storedDraftValue"
          :effective-value="section.effectiveValue"
          :layer-features="section.model.kind === 'layered' ? section.model.layerFeatures : undefined"
          :is-layered="section.isLayered"
          :depth="0"
          @update:model-value="(value) => { section.draftValue = value; }"
        />
      </div>
    </template>
  </div>
</template>
```

```ts
// webui/src/sections/registry.ts
import type { WorkbenchSection } from "@/composables/workbench/useWorkbenchRegistry";
import { configSection } from "./config";

export const workbenchSections: WorkbenchSection[] = [
  configSection
];
```

```vue
<!-- webui/src/sections/config/ConfigMobileHeader.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useConfigSection } from "@/composables/sections/useConfigSection";

const section = useConfigSection();
const title = computed(() => section.model.value?.title ?? "");
</script>

<template>
  <span v-if="title" class="truncate text-ui font-medium text-text-secondary">{{ title }}</span>
</template>
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `node --test test/webui/layout/section-migration-source.test.ts`
Expected: PASS for the config assertions.

- [ ] **Step 5: Commit**

```bash
git add \
  webui/src/sections/config/index.ts \
  webui/src/composables/sections/useConfigSection.ts \
  webui/src/sections/config/ConfigListPane.vue \
  webui/src/sections/config/ConfigMainPane.vue \
  webui/src/sections/config/ConfigMobileHeader.vue \
  webui/src/sections/registry.ts \
  webui/src/pages/ConfigPage.vue \
  test/webui/layout/section-migration-source.test.ts
git commit -m "refactor: migrate config page to workbench section"
```

## Task 4: Migrate Data to a Registered Section

**Files:**
- Create: `webui/src/sections/data/index.ts`
- Create: `webui/src/composables/sections/useDataSection.ts`
- Create: `webui/src/sections/data/DataListPane.vue`
- Create: `webui/src/sections/data/DataMainPane.vue`
- Create: `webui/src/sections/data/DataMobileHeader.vue`
- Modify: `webui/src/sections/registry.ts`
- Modify: `webui/src/pages/DataPage.vue`
- Modify: `test/webui/layout/section-migration-source.test.ts`

- [ ] **Step 1: Extend the migration test with data assertions**

```ts
test("data page becomes a thin section host entry point", async () => {
  const source = await readFile(
    new URL("../../../webui/src/pages/DataPage.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /SectionHost/);
  assert.match(source, /section-id="data"/);
  assert.doesNotMatch(source, /<AppLayout/);
});

test("data section registers list main and mobile header panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/data/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /id: "data"/);
  assert.match(source, /routeName: "data"/);
  assert.match(source, /listPane: DataListPane/);
  assert.match(source, /mainPane: DataMainPane/);
  assert.match(source, /mobileHeader: DataMobileHeader/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/webui/layout/section-migration-source.test.ts`
Expected: FAIL on `data` assertions because the section files do not exist yet.

- [ ] **Step 3: Split DataPage into registered panes**

```ts
// webui/src/sections/data/index.ts
import type { WorkbenchSection } from "@/composables/workbench/useWorkbenchRegistry";
import DataListPane from "./DataListPane.vue";
import DataMainPane from "./DataMainPane.vue";
import DataMobileHeader from "./DataMobileHeader.vue";

export const dataSection: WorkbenchSection = {
  id: "data",
  title: "数据",
  routeName: "data",
  regions: {
    listPane: DataListPane,
    mainPane: DataMainPane,
    mobileHeader: DataMobileHeader
  },
  layout: {
    mobileMainFlow: "list-main",
    auxMode: "drawer",
    defaults: {
      topbar: false,
      auxPane: false,
      statusbar: false
    }
  }
};
```

```ts
// webui/src/composables/sections/useDataSection.ts
import { ref, computed, watch } from "vue";
import { dataApi, type DataResource, type DataResourceItem, type DirectoryItem } from "@/api/data";
import { editorApi, type EditorResourceSummary, type EditorModel } from "@/api/editor";
import { useLayeredEditorState } from "@/composables/useLayeredEditorState";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";

type DataListResource =
  | { key: string; title: string; source: "browser"; kind: "single_json" | "directory_json"; editable: false }
  | { key: string; title: string; source: "editor"; kind: EditorResourceSummary["kind"]; editable: boolean };

const resources = ref<DataListResource[]>([]);
const selectedKey = ref<string | null>(null);
const selectedItemKey = ref<string | null>(null);
const resource = ref<DataResource | null>(null);
const itemDetail = ref<DataResourceItem | null>(null);
const model = ref<EditorModel | null>(null);
const loading = ref(false);
const loadingItem = ref(false);
const editorState = useLayeredEditorState(model);
let resourcesLoaded = false;

const selectedResource = computed(() =>
  resources.value.find((entry) => entry.key === selectedKey.value) ?? null
);

async function ensureResourcesLoaded() {
  if (resourcesLoaded) return;
  const [dataRes, editorRes] = await Promise.all([dataApi.list(), editorApi.list()]);
  resources.value = [
    ...editorRes.resources
      .filter((entry) => entry.domain === "data")
      .map((entry) => ({
        key: entry.key,
        title: entry.title,
        source: "editor" as const,
        kind: entry.kind,
        editable: entry.editable
      })),
    ...dataRes.resources.map((entry) => ({
      key: entry.key,
      title: entry.title,
      source: "browser" as const,
      kind: entry.kind,
      editable: false as const
    }))
  ];
  resourcesLoaded = true;
}

watch(selectedKey, async (key) => {
  resource.value = null;
  itemDetail.value = null;
  model.value = null;
  if (!key) {
    return;
  }
  loading.value = true;
  try {
    const target = resources.value.find((entry) => entry.key === key);
    if (!target) return;
    if (target.source === "browser") {
      resource.value = (await dataApi.get(key)).resource;
      return;
    }
    model.value = (await editorApi.load(key)).editor;
  } finally {
    loading.value = false;
  }
});

watch(selectedItemKey, async (itemKey) => {
  if (!itemKey || !selectedKey.value || selectedResource.value?.source !== "browser") {
    return;
  }
  loadingItem.value = true;
  try {
    itemDetail.value = (await dataApi.getItem(selectedKey.value, itemKey)).item;
  } finally {
    loadingItem.value = false;
  }
});

export function useDataSection() {
  const runtime = useWorkbenchRuntime();

  function selectResource(key: string) {
    selectedKey.value = key;
    runtime.showMain();
  }

  function selectDirectoryItem(key: string) {
    selectedItemKey.value = key;
    runtime.showMain();
  }

  return {
    resources,
    selectedKey,
    selectedItemKey,
    selectedResource,
    resource,
    itemDetail,
    model,
    loading,
    loadingItem,
    selectResource,
    selectDirectoryItem,
    ensureResourcesLoaded,
    ...editorState
  };
}
```

```vue
<!-- webui/src/pages/DataPage.vue -->
<script setup lang="ts">
import SectionHost from "@/components/workbench/SectionHost.vue";
</script>

<template>
  <SectionHost section-id="data" />
</template>
```

```vue
<!-- webui/src/sections/data/DataListPane.vue -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useDataSection } from "@/composables/sections/useDataSection";

const section = useDataSection();
onMounted(() => {
  void section.ensureResourcesLoaded();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div class="panel-header flex h-10 shrink-0 items-center border-b px-3">
      <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">数据</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <button
        v-for="entry in section.resources"
        :key="entry.key"
        class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left"
        :class="{ 'is-selected': section.selectedKey === entry.key }"
        @click="section.selectResource(entry.key)"
      >
        <span class="text-ui text-text-secondary">{{ entry.title }}</span>
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ entry.kind }}</span>
      </button>
    </div>
  </div>
</template>
```

```vue
<!-- webui/src/sections/data/DataMainPane.vue -->
<script setup lang="ts">
import SchemaNode from "@/components/editor/SchemaNode.vue";
import { useDataSection } from "@/composables/sections/useDataSection";

const section = useDataSection();
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div v-if="!section.selectedKey" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个数据资源</div>
    <div v-else-if="section.loading" class="panel-empty flex flex-1 items-center justify-center gap-2">加载中…</div>
    <template v-else-if="section.selectedResource?.source === 'editor' && section.model">
      <header class="toolbar-header flex min-h-10 shrink-0 flex-wrap items-center gap-2.5 border-b px-4 py-1.5">
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ section.model.kind }}</span>
      </header>
      <div class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
        <SchemaNode
          :node="section.model.uiTree"
          :model-value="section.draftValue"
          :inherited="section.model.kind === 'layered' ? section.baseValue : section.model.current"
          :base-value="section.isLayered ? section.baseValue : undefined"
          :stored-value="section.storedDraftValue"
          :effective-value="section.effectiveValue"
          :layer-features="section.model.kind === 'layered' ? section.model.layerFeatures : undefined"
          :is-layered="section.isLayered"
          :depth="0"
          @update:model-value="(value) => { section.draftValue = value; }"
        />
      </div>
    </template>
  </div>
</template>
```

```ts
// webui/src/sections/registry.ts
import type { WorkbenchSection } from "@/composables/workbench/useWorkbenchRegistry";
import { configSection } from "./config";
import { dataSection } from "./data";

export const workbenchSections: WorkbenchSection[] = [
  configSection,
  dataSection
];
```

```vue
<!-- webui/src/sections/data/DataMobileHeader.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useDataSection } from "@/composables/sections/useDataSection";

const section = useDataSection();
const title = computed(() => {
  if (section.selectedResource.value?.source === "editor" && section.model.value) {
    return section.model.value.title;
  }
  if (section.itemDetail.value) {
    return section.itemDetail.value.title || section.itemDetail.value.key;
  }
  return section.resource.value?.title ?? "";
});
</script>

<template>
  <span v-if="title" class="truncate text-ui font-medium text-text-secondary">{{ title }}</span>
</template>
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `node --test test/webui/layout/section-migration-source.test.ts`
Expected: PASS for the config and data assertions.

- [ ] **Step 5: Commit**

```bash
git add \
  webui/src/sections/data/index.ts \
  webui/src/composables/sections/useDataSection.ts \
  webui/src/sections/data/DataListPane.vue \
  webui/src/sections/data/DataMainPane.vue \
  webui/src/sections/data/DataMobileHeader.vue \
  webui/src/sections/registry.ts \
  webui/src/pages/DataPage.vue \
  test/webui/layout/section-migration-source.test.ts
git commit -m "refactor: migrate data page to workbench section"
```

## Task 5: Migrate Settings to a Registered Section

**Files:**
- Create: `webui/src/sections/settings/index.ts`
- Create: `webui/src/composables/sections/useSettingsSection.ts`
- Create: `webui/src/sections/settings/SettingsListPane.vue`
- Create: `webui/src/sections/settings/SettingsMainPane.vue`
- Create: `webui/src/sections/settings/SettingsMobileHeader.vue`
- Modify: `webui/src/sections/registry.ts`
- Modify: `webui/src/pages/SettingsPage.vue`
- Modify: `test/webui/layout/section-migration-source.test.ts`

- [ ] **Step 1: Extend the migration test with settings assertions**

```ts
test("settings page becomes a thin section host entry point", async () => {
  const source = await readFile(
    new URL("../../../webui/src/pages/SettingsPage.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /SectionHost/);
  assert.match(source, /section-id="settings"/);
  assert.doesNotMatch(source, /<AppLayout/);
});

test("settings section registers list main and mobile header panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/settings/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /id: "settings"/);
  assert.match(source, /routeName: "settings"/);
  assert.match(source, /listPane: SettingsListPane/);
  assert.match(source, /mainPane: SettingsMainPane/);
  assert.match(source, /mobileHeader: SettingsMobileHeader/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/webui/layout/section-migration-source.test.ts`
Expected: FAIL on `settings` assertions because the section files do not exist yet.

- [ ] **Step 3: Split SettingsPage into registered panes**

```ts
// webui/src/sections/settings/index.ts
import type { WorkbenchSection } from "@/composables/workbench/useWorkbenchRegistry";
import SettingsListPane from "./SettingsListPane.vue";
import SettingsMainPane from "./SettingsMainPane.vue";
import SettingsMobileHeader from "./SettingsMobileHeader.vue";

export const settingsSection: WorkbenchSection = {
  id: "settings",
  title: "设置",
  routeName: "settings",
  regions: {
    listPane: SettingsListPane,
    mainPane: SettingsMainPane,
    mobileHeader: SettingsMobileHeader
  },
  layout: {
    mobileMainFlow: "list-main",
    auxMode: "drawer",
    defaults: {
      topbar: false,
      auxPane: false,
      statusbar: false
    }
  }
};
```

```ts
// webui/src/composables/sections/useSettingsSection.ts
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { authApi, type AuthSettings } from "@/api/auth";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";

const activeItem = ref<"auth" | "logout">("auth");
const settings = ref<AuthSettings | null>(null);
const loadingSettings = ref(false);

export function useSettingsSection() {
  const router = useRouter();
  const auth = useAuthStore();
  const runtime = useWorkbenchRuntime();
  const supportsPasskey = computed(() => typeof window !== "undefined" && "PublicKeyCredential" in window);

  async function refreshSettings() {
    loadingSettings.value = true;
    try {
      settings.value = await authApi.settings();
    } finally {
      loadingSettings.value = false;
    }
  }

  function selectItem(item: "auth" | "logout") {
    activeItem.value = item;
    runtime.showMain();
  }

  return {
    auth,
    router,
    activeItem,
    settings,
    loadingSettings,
    supportsPasskey,
    refreshSettings,
    selectItem
  };
}
```

```vue
<!-- webui/src/pages/SettingsPage.vue -->
<script setup lang="ts">
import SectionHost from "@/components/workbench/SectionHost.vue";
</script>

<template>
  <SectionHost section-id="settings" />
</template>
```

```vue
<!-- webui/src/sections/settings/SettingsListPane.vue -->
<script setup lang="ts">
import { onMounted } from "vue";
import { LockKeyhole, LogOut } from "lucide-vue-next";
import { useSettingsSection } from "@/composables/sections/useSettingsSection";

const section = useSettingsSection();
onMounted(() => {
  if (section.auth.enabled) {
    void section.refreshSettings();
  }
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div class="panel-header flex h-10 shrink-0 items-center border-b px-3">
      <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">设置</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <button class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left" :class="{ 'is-selected': section.activeItem === 'auth' }" @click="section.selectItem('auth')">
        <span class="text-ui text-text-secondary">认证</span>
        <LockKeyhole :size="14" :stroke-width="1.75" class="text-text-subtle" />
      </button>
      <button v-if="section.auth.enabled" class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left" :class="{ 'is-selected': section.activeItem === 'logout' }" @click="section.selectItem('logout')">
        <span class="text-ui text-text-secondary">退出登录</span>
        <LogOut :size="14" :stroke-width="1.75" class="text-text-subtle" />
      </button>
    </div>
  </div>
</template>
```

```vue
<!-- webui/src/sections/settings/SettingsMainPane.vue -->
<script setup lang="ts">
import { useSettingsSection } from "@/composables/sections/useSettingsSection";

const section = useSettingsSection();
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="toolbar-header flex h-10 shrink-0 items-center gap-2.5 border-b px-4">
      <span class="text-ui font-medium text-text-secondary">{{ section.activeItem === "auth" ? "认证设置" : "退出登录" }}</span>
    </header>
    <div v-if="section.activeItem === 'auth'" class="scrollbar-thin flex-1 overflow-y-auto p-4">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div v-if="!section.auth.enabled" class="rounded-xl border border-border-default bg-surface-panel p-4">
          <div class="mb-2 text-ui font-medium text-text-primary">认证已关闭</div>
          <p class="m-0 text-small text-text-muted">当前实例在配置中关闭了 WebUI 认证。</p>
        </div>
      </div>
    </div>
    <div v-else class="flex flex-1 items-center justify-center p-4">
      <div class="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border-default bg-surface-panel p-4">
        <p class="m-0 text-small text-text-muted">退出当前 WebUI 会话，返回登录页。</p>
      </div>
    </div>
  </div>
</template>
```

```ts
// webui/src/sections/registry.ts
import type { WorkbenchSection } from "@/composables/workbench/useWorkbenchRegistry";
import { configSection } from "./config";
import { dataSection } from "./data";
import { settingsSection } from "./settings";

export const workbenchSections: WorkbenchSection[] = [
  configSection,
  dataSection,
  settingsSection
];
```

```vue
<!-- webui/src/sections/settings/SettingsMobileHeader.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useSettingsSection } from "@/composables/sections/useSettingsSection";

const section = useSettingsSection();
const title = computed(() => section.activeItem.value === "auth" ? "认证设置" : "退出登录");
</script>

<template>
  <span class="truncate text-ui font-medium text-text-secondary">{{ title }}</span>
</template>
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `node --test test/webui/layout/section-migration-source.test.ts`
Expected: PASS for config, data, and settings assertions.

- [ ] **Step 5: Commit**

```bash
git add \
  webui/src/sections/settings/index.ts \
  webui/src/composables/sections/useSettingsSection.ts \
  webui/src/sections/settings/SettingsListPane.vue \
  webui/src/sections/settings/SettingsMainPane.vue \
  webui/src/sections/settings/SettingsMobileHeader.vue \
  webui/src/sections/registry.ts \
  webui/src/pages/SettingsPage.vue \
  test/webui/layout/section-migration-source.test.ts
git commit -m "refactor: migrate settings page to workbench section"
```

## Task 6: Verify Phase 1 and Record Deferred Areas

**Files:**
- Modify: `docs/superpowers/specs/2026-04-20-webui-workbench-layout-extraction-design.md`
- Modify: `docs/superpowers/plans/2026-04-20-webui-workbench-layout-phase-1.md`

- [ ] **Step 1: Add explicit phase-1 completion notes to the spec**

```md
## Phase 1 status notes

- `Config / Data / Settings` 已切到 `SectionHost`
- `Sessions / Workspace` 仍保留旧布局，作为第二阶段迁移对象
- `topbar / auxPane / statusbar / mobile menus` 已进入 contract，但仍为壳层占位
```

- [ ] **Step 2: Run focused webui layout tests**

Run: `node --test test/webui/layout/workbench-registry-source.test.ts test/webui/layout/section-host-source.test.ts test/webui/layout/section-migration-source.test.ts`
Expected: PASS for all newly added layout tests.

- [ ] **Step 3: Run repository verification and record baseline failures without fixing unrelated issues**

Run: `npm run typecheck:all`
Expected: either PASS, or the same pre-existing baseline failures already recorded in this plan.

Run: `npm run test`
Expected: either PASS, or the same pre-existing baseline failures already recorded in this plan.

- [ ] **Step 4: Commit**

```bash
git add \
  docs/superpowers/specs/2026-04-20-webui-workbench-layout-extraction-design.md \
  docs/superpowers/plans/2026-04-20-webui-workbench-layout-phase-1.md \
  test/webui/layout/workbench-registry-source.test.ts \
  test/webui/layout/section-host-source.test.ts \
  test/webui/layout/section-migration-source.test.ts
git commit -m "docs: record phase 1 workbench migration status"
```

## Self-Review

### Spec coverage

- 唯一 `WorkbenchShell`：Task 2
- 静态 `WorkbenchRegistry`：Task 1, Task 2
- 统一 `WorkbenchRuntime`：Task 1
- `Config / Data / Settings` 迁移：Task 3, Task 4, Task 5
- contract 预留未来区域：Task 1
- page 变薄：Task 3, Task 4, Task 5
- 基线失败单独记录：Task 6

无遗漏。

### Placeholder scan

- 未使用 `TODO` / `TBD`
- 所有任务都给出了明确文件路径
- 所有代码修改步骤都附了代码块
- 所有验证步骤都包含具体命令和期望结果

### Type consistency

- `WorkbenchSection`、`useWorkbenchRuntime()`、`SectionHost`、`WorkbenchShell` 命名在各任务中保持一致
- `useConfigSection()`、`useDataSection()`、`useSettingsSection()` 已在各自迁移任务中定义
- 运行时方法统一为 `showList()` / `showMain()` / `openAux()` / `closeAux()` / `toggleTopMenu()` / `toggleBottomMenu()`
- 区域命名统一为 `listPane` / `mainPane` / `auxPane` / `topbar` / `statusbar` / `mobileHeader` / `mobileTopMenu` / `mobileBottomMenu`

未发现前后命名冲突。

## Verification Snapshot

- `node --test test/webui/layout/workbench-registry-source.test.ts test/webui/layout/section-host-source.test.ts test/webui/layout/section-migration-source.test.ts`
  - 结果：通过
- `npx tsx --test test/webui/layout/app-layout.test.tsx`
  - 结果：通过
- `npm run typecheck:all`
  - 结果：仍有既有基线失败
  - `webui/build/gzipPrecompression.ts`
  - `webui/src/api/uploadPreparation.ts`
  - `webui/src/stores/toasts.ts`
- `npm run test`
  - 结果：仍有既有基线失败
  - `test/webui/app/toast.test.ts`

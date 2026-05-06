# @workbench-kit/vue-file-workspace

通用文件工作区组件包，提供文件树组件、文件列表/预览类型和 `FileWorkspaceClient` 契约。

这个包只负责渲染文件树和定义文件 API 形状，不负责请求后端、预览器、权限、安全过滤或业务语义。业务项目负责实现 client adapter，并维护展开目录、选中文件和预览状态。

## 依赖

业务项目需要提供 peer dependencies：

```bash
npm install vue lucide-vue-next @workbench-kit/vue-workbench
```

当前仓库内通过源码 alias 使用：

```json
{
  "paths": {
    "@workbench-kit/vue-file-workspace": ["../packages/vue-file-workspace/src/index.ts"]
  }
}
```

迁出独立仓库并发布后，业务项目应改为普通依赖：

```bash
npm install @workbench-kit/vue-file-workspace
```

## 样式和 Tailwind source

本包的 `FileTree` 依赖 `@workbench-kit/vue-workbench` 的 `TreeNodeShell` 和基础样式。业务项目必须先完成 workbench 样式接入：

```css
@import "./theme.css";
@import "tailwindcss";
@import "tailwindcss-safe-area";
@import "@workbench-kit/vue-workbench/style.css";
```

如果本包以源码包形式位于业务源码目录之外，还需要把包源码加入 Tailwind source：

```css
@source "../../../packages/vue-file-workspace/src";
```

如果包来自 `node_modules`，路径通常类似：

```css
@source "../node_modules/@workbench-kit/vue-file-workspace";
```

路径以当前 CSS 文件位置为准。

## 入口

```ts
import {
  FileTree,
  type FileWorkspaceClient,
  type LocalFileItem,
  type LocalFileListResult,
  type LocalFilePreview
} from "@workbench-kit/vue-file-workspace";
```

## Client adapter

业务项目适配自己的文件 API：

```ts
import type { FileWorkspaceClient } from "@workbench-kit/vue-file-workspace";

export const fileApi: FileWorkspaceClient = {
  async listItems(path) {
    return requestJson(`/api/workspace/files?path=${encodeURIComponent(path)}`);
  },
  async readFile(path, range) {
    const params = new URLSearchParams({ path });
    if (range?.startLine !== undefined) params.set("startLine", String(range.startLine));
    if (range?.endLine !== undefined) params.set("endLine", String(range.endLine));
    return requestJson(`/api/workspace/file?${params.toString()}`);
  },
  getContentUrl(path) {
    return `/api/workspace/content?path=${encodeURIComponent(path)}`;
  }
};
```

`listItems(path)` 返回：

```ts
{
  root: "/workspace",
  path: "src",
  items: [
    {
      path: "src/index.ts",
      name: "index.ts",
      kind: "file",
      sizeBytes: 1024,
      updatedAtMs: 1730000000000
    }
  ]
}
```

`readFile(path, range)` 返回文本预览：

```ts
{
  path: "src/index.ts",
  content: "console.log('hello');",
  startLine: 1,
  endLine: 1,
  totalLines: 1,
  truncated: false
}
```

## 渲染 FileTree

`FileTree` 只渲染树，不自己请求数据。业务页面负责维护：

- 根目录 `items`
- 已展开目录 `expandedPaths`
- 目录子项缓存 `itemsByPath`
- 当前选中项 `selectedPath`
- 展开/收起目录逻辑
- 文件预览逻辑

示例：

```vue
<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { FileTree, type LocalFileItem } from "@workbench-kit/vue-file-workspace";
import { fileApi } from "../api/workspace";

const rootItems = ref<LocalFileItem[]>([]);
const expandedPaths = ref<string[]>([]);
const itemsByPath = reactive<Record<string, LocalFileItem[]>>({});
const selectedPath = ref<string | null>(null);

async function loadPath(path: string) {
  const result = await fileApi.listItems(path);
  if (path === "") {
    rootItems.value = result.items;
  } else {
    itemsByPath[path] = result.items;
  }
}

async function toggleDirectory(path: string) {
  if (expandedPaths.value.includes(path)) {
    expandedPaths.value = expandedPaths.value.filter((item) => item !== path);
    return;
  }
  expandedPaths.value = [...expandedPaths.value, path];
  if (!itemsByPath[path]) {
    await loadPath(path);
  }
}

function selectItem(item: LocalFileItem) {
  selectedPath.value = item.path;
  if (item.kind === "directory") {
    void toggleDirectory(item.path);
  }
}

onMounted(() => {
  void loadPath("");
});
</script>

<template>
  <FileTree
    :items="rootItems"
    :expanded-paths="expandedPaths"
    :items-by-path="itemsByPath"
    :selected-path="selectedPath"
    @toggle-directory="toggleDirectory"
    @select-item="selectItem"
  />
</template>
```

## 职责边界

本包负责：

- 文件树视觉结构。
- 文件/目录图标。
- 目录展开状态的事件协议。
- 文件列表、文件预览和 client 类型。

业务项目负责：

- 文件 API。
- 路径权限和安全过滤。
- 文件预览器。
- 图片、二进制、媒体文件展示。
- 上传、删除、重命名等写操作。

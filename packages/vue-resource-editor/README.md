# @workbench-kit/vue-resource-editor

Schema 驱动资源编辑器包，提供资源编辑器类型、递归 schema 编辑组件、草稿状态、资源编辑状态工厂和 editor client 契约。

这个包不负责请求后端、路由跳转或 toast 展示。业务项目需要实现 `ResourceEditorClient`，再把数据和状态接入页面。

## 依赖

业务项目需要提供 peer dependencies：

```bash
npm install vue lucide-vue-next @workbench-kit/vue-workbench
```

当前仓库内通过源码 alias 使用：

```json
{
  "paths": {
    "@workbench-kit/vue-resource-editor": ["../packages/vue-resource-editor/src/index.ts"]
  }
}
```

迁出独立仓库并发布后，业务项目应改为普通依赖：

```bash
npm install @workbench-kit/vue-resource-editor
```

## 样式和 Tailwind source

本包组件依赖 `@workbench-kit/vue-workbench` 的基础样式和 primitives。业务项目必须完成 workbench 样式接入：

```css
@import "./theme.css";
@import "tailwindcss";
@import "tailwindcss-safe-area";
@import "@workbench-kit/vue-workbench/style.css";
```

如果本包以源码包形式位于业务源码目录之外，还需要把包源码加入 Tailwind source：

```css
@source "../../../packages/vue-resource-editor/src";
```

如果包来自 `node_modules`，路径通常类似：

```css
@source "../node_modules/@workbench-kit/vue-resource-editor";
```

路径以当前 CSS 文件位置为准。

## 入口

```ts
import {
  SchemaNode,
  SchemaField,
  createResourceEditorState,
  configureResourceEditorClient,
  useResourceEditorClient,
  useEditorDraftState,
  type ResourceEditorClient,
  type ResourceEditorState,
  type EditorModel,
  type EditorResourceSummary
} from "@workbench-kit/vue-resource-editor";
```

## Client adapter

业务项目需要把自己的 HTTP API 或本地数据源适配成 `ResourceEditorClient`：

```ts
import type { ResourceEditorClient } from "@workbench-kit/vue-resource-editor";

export const editorApi: ResourceEditorClient = {
  async list() {
    return requestJson("/api/editor/resources");
  },
  async load(key) {
    return requestJson(`/api/editor/resources/${encodeURIComponent(key)}`);
  },
  async validate(key, value) {
    return requestJson(`/api/editor/resources/${encodeURIComponent(key)}/validate`, {
      method: "POST",
      body: JSON.stringify({ value })
    });
  },
  async save(key, value) {
    return requestJson(`/api/editor/resources/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value })
    });
  }
};
```

应用启动时可以注册 active client：

```ts
import { configureResourceEditorClient } from "@workbench-kit/vue-resource-editor";
import { editorApi } from "./api/editor";

configureResourceEditorClient(editorApi);
```

## ResourceEditorClient 返回结构

`list()` 返回资源摘要：

```ts
{
  resources: [
    {
      key: "config.global",
      title: "Global Config",
      domain: "config",
      kind: "layered",
      editable: true
    }
  ]
}
```

`load(key)` 返回完整 editor model：

```ts
{
  editor: {
    key: "config.global",
    title: "Global Config",
    editable: true,
    kind: "layered",
    writableLayerKey: "instance",
    layers: [],
    schemaMeta,
    uiTree,
    template,
    schemaDefaultValue,
    currentValue,
    referenceValue,
    effectiveValue,
    editorFeatures
  }
}
```

其中：

- `schemaMeta` 是 schema 元数据。
- `uiTree` 是用于渲染的 UI 树。
- `currentValue` 是当前可编辑层的值。
- `referenceValue` 是参考层或继承值。
- `schemaDefaultValue` 是 schema 默认值展开后的最低优先级值。
- `effectiveValue` 是最终生效值。
- `editorFeatures` 控制参考背景、unset 行为和 draft effective 计算方式。

## createResourceEditorState

`createResourceEditorState` 封装资源列表、选中项、加载、草稿、校验、保存和 reload。

```ts
import {
  createResourceEditorState,
  type ResourceEditorState
} from "@workbench-kit/vue-resource-editor";
import { useWorkbenchNavigation, useWorkbenchToasts } from "@workbench-kit/vue-workbench";
import { editorApi } from "../api/editor";

export function useConfigEditor(): ResourceEditorState {
  const toast = useWorkbenchToasts();
  const navigation = useWorkbenchNavigation();

  return createResourceEditorState({
    client: editorApi,
    domain: "config",
    editableOnly: true,
    onSelect: () => navigation.showArea("mainArea"),
    notify: (notification) => toast.push(notification),
    saveSuccessMessage: (path) => `已保存 -> ${path}`
  });
}
```

常用字段：

- `resources`：资源列表。
- `selectedKey`：当前资源 key。
- `model`：当前 editor model。
- `loading` / `saving` / `validating`：异步状态。
- `draftValue`：当前草稿值，可直接绑定 `SchemaNode`。
- `referenceValue`：参考值。
- `storedDraftValue`：已保存的当前层值。
- `effectiveValue`：最终生效值。
- `isDirty`：草稿是否已改动。
- `canValidate` / `canSave`：按钮可用性。
- `refreshResources()`：刷新资源列表。
- `selectResource(key)`：切换资源并触发加载。
- `updateDraft(value)`：更新草稿。
- `validate()`：调用 client 校验。
- `save()`：调用 client 保存并重新加载。
- `reloadFromServer()`：丢弃本地草稿并重新加载服务端值。

## 渲染 SchemaNode

`SchemaNode` 是递归 schema 编辑器。业务页面负责布局、toolbar、列表和按钮。

```vue
<script setup lang="ts">
import { onMounted } from "vue";
import { SchemaNode } from "@workbench-kit/vue-resource-editor";
import { useConfigEditor } from "./useConfigEditor";

const editor = useConfigEditor();

onMounted(() => {
  void editor.refreshResources();
});
</script>

<template>
  <section v-if="editor.model" class="flex min-h-0 flex-1 flex-col">
    <header class="panel-header flex items-center justify-between border-b px-3 py-2">
      <span class="font-medium">{{ editor.model.title }}</span>
      <div class="flex gap-2">
        <button class="btn btn-secondary" :disabled="!editor.canValidate" @click="editor.validate">
          验证
        </button>
        <button class="btn btn-primary" :disabled="!editor.canSave" @click="editor.save">
          保存
        </button>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-auto p-3">
      <SchemaNode
        :node="editor.model.uiTree"
        v-model="editor.draftValue"
        :inherited="editor.referenceValue"
        :stored-value="editor.storedDraftValue"
        :effective-value="editor.effectiveValue"
        :editor-features="editor.model.editorFeatures"
      />
    </div>
  </section>
</template>
```

## 职责边界

本包负责：

- schema 树渲染。
- 字段编辑。
- 草稿、参考值、有效值的状态组织。
- validate/save/reload 的通用状态流程。

业务项目负责：

- 后端 API。
- schema 元数据生成。
- resource 注册。
- 页面布局和 toolbar。
- toast 和导航接线。
- 权限、认证、业务字段含义。

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, Download, File, Folder, RefreshCw } from "lucide-vue-next";
import { ResponsiveSplitPane, WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchIconButton, WorkbenchListItem } from "@workbench-kit/vue";
import { workspacesApi, type WorkspaceFile, type WorkspaceResource, type WorkspaceText } from "@/api/workspaces";

const props = defineProps<{ workspace: WorkspaceResource | null }>();
const directory = ref(".");
const items = ref<WorkspaceFile[]>([]);
const selected = ref<WorkspaceFile | null>(null);
const text = ref<WorkspaceText | null>(null);
const activePane = ref<"primary" | "secondary">("primary");
const listLoading = ref(false);
const previewLoading = ref(false);
const listError = ref("");
const previewError = ref("");
const truncated = ref(false);
let listVersion = 0;
let previewVersion = 0;
const active = computed(() => props.workspace?.status === "active");
const previewKind = computed(() => {
  const name = selected.value?.name.toLowerCase() ?? "";
  if (/\.(png|jpe?g|gif|webp)$/.test(name)) return "image";
  if (/\.(mp3|wav|ogg)$/.test(name)) return "audio";
  if (/\.(mp4|webm)$/.test(name)) return "video";
  return "text";
});
const contentUrl = computed(() => props.workspace && selected.value ? workspacesApi.contentUrl(props.workspace.resource_id, selected.value.path) : "");
const downloadUrl = computed(() => props.workspace && selected.value ? workspacesApi.contentUrl(props.workspace.resource_id, selected.value.path, true) : "");
const crumbs = computed(() => directory.value === "." ? [] : directory.value.split("/").map((name, i, parts) => ({ name, path: parts.slice(0, i + 1).join("/") })));

watch(() => [props.workspace?.resource_id, props.workspace?.status], () => {
  listVersion++; previewVersion++;
  directory.value = "."; items.value = []; selected.value = null; text.value = null;
  listError.value = ""; previewError.value = ""; activePane.value = "primary";
  listLoading.value = false; previewLoading.value = false;
  if (active.value) void loadDirectory(".");
}, { immediate: true });

async function loadDirectory(path: string) {
  if (!props.workspace || !active.value) return;
  const version = ++listVersion;
  listLoading.value = true; listError.value = "";
  try {
    const result = await workspacesApi.files(props.workspace.resource_id, path);
    if (version !== listVersion) return;
    directory.value = result.path;
    items.value = result.items.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    truncated.value = result.truncated;
  } catch (error) { if (version === listVersion) listError.value = message(error); }
  finally { if (version === listVersion) listLoading.value = false; }
}
async function selectFile(file: WorkspaceFile) {
  if (file.kind === "directory") { await loadDirectory(file.path); return; }
  previewVersion++;
  selected.value = file; text.value = null; previewError.value = ""; previewLoading.value = false;
  activePane.value = "secondary";
  if (previewKind.value === "text") await loadText();
}
async function loadText(startLine = 1) {
  if (!props.workspace || !selected.value) return;
  const version = ++previewVersion;
  previewLoading.value = true; previewError.value = "";
  try {
    const result = await workspacesApi.text(props.workspace.resource_id, selected.value.path, startLine);
    if (version === previewVersion) text.value = result;
  } catch (error) { if (version === previewVersion) { text.value = null; previewError.value = message(error); } }
  finally { if (version === previewVersion) previewLoading.value = false; }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function bytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`; }
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <WorkbenchAreaHeader :title="workspace?.name ?? '工作区'">
      <template #actions><WorkbenchIconButton :icon="RefreshCw" title="刷新目录" :disabled="!active || listLoading" @click="loadDirectory(directory)" /></template>
    </WorkbenchAreaHeader>
    <div v-if="workspace" class="border-b border-border-subtle px-3 py-2 text-small text-text-muted">
      {{ workspace.ownerSessionId }} · 到期 {{ new Date(workspace.expiresAtMs).toLocaleString() }}
    </div>
    <WorkbenchEmptyState v-if="!workspace" message="请选择工作区" />
    <WorkbenchEmptyState v-else-if="!active" :message="workspace.status === 'expired' ? '工作区已过期，文件不可访问' : '工作区已关闭'" />
    <ResponsiveSplitPane v-else class="min-h-0 flex-1" :breakpoint="760" :default-primary-size="300" :min-primary-size="200" :min-secondary-size="240"
      primary-title="文件" secondary-title="预览" storage-key="resources.workspace.split" v-model:active-pane-id="activePane">
      <template #primary>
        <div class="flex h-full min-h-0 flex-col">
          <nav class="flex flex-wrap items-center gap-1 border-b border-border-subtle p-2 text-small" aria-label="目录导航">
            <WorkbenchIconButton :icon="ArrowLeft" title="上级目录" :disabled="directory === '.' || listLoading" @click="loadDirectory(directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '.')" />
            <button class="text-accent hover:underline" @click="loadDirectory('.')">根目录</button>
            <template v-for="crumb in crumbs" :key="crumb.path"><span>/</span><button class="break-all text-accent hover:underline" @click="loadDirectory(crumb.path)">{{ crumb.name }}</button></template>
          </nav>
          <div v-if="listError" role="alert" class="p-3 text-small text-danger">{{ listError }}</div>
          <div class="scrollbar-thin min-h-0 flex-1 overflow-auto p-2" :aria-busy="listLoading">
            <WorkbenchListItem v-for="file in items" :key="file.path" :title="file.name" :meta="file.kind === 'directory' ? '目录' : bytes(file.sizeBytes)" :selected="selected?.path === file.path" @select="selectFile(file)">
              <template #icon><component :is="file.kind === 'directory' ? Folder : File" :size="15" /></template>
            </WorkbenchListItem>
            <WorkbenchEmptyState v-if="!items.length && !listLoading && !listError" message="目录为空" />
            <p v-if="truncated" class="p-2 text-small text-text-muted">仅显示前 500 项，可通过文件搜索工具定位其他文件。</p>
          </div>
        </div>
      </template>
      <template #secondary>
        <div class="flex h-full min-h-0 flex-col">
          <div v-if="selected" class="flex items-center gap-2 border-b border-border-subtle p-3 text-small">
            <span class="min-w-0 flex-1 break-all">{{ selected.path }} · {{ bytes(selected.sizeBytes) }}</span>
            <a :href="downloadUrl" class="flex shrink-0 items-center gap-1 text-accent" download><Download :size="14" />下载</a>
          </div>
          <WorkbenchEmptyState v-if="!selected" message="选择文件以预览" />
          <div v-else class="scrollbar-thin min-h-0 flex-1 overflow-auto p-3" :aria-busy="previewLoading">
            <p v-if="previewLoading" class="text-small text-text-muted">正在读取…</p>
            <p v-else-if="previewError" role="alert" class="text-small text-text-muted">无法预览：{{ previewError }}。可下载文件查看。</p>
            <img v-else-if="previewKind === 'image'" :key="contentUrl" :src="contentUrl" :alt="selected.name" class="mx-auto max-h-full max-w-full object-contain" @error="previewError = '图片加载失败'">
            <audio v-else-if="previewKind === 'audio'" :key="contentUrl" :src="contentUrl" controls class="w-full" @error="previewError = '音频加载失败'" />
            <video v-else-if="previewKind === 'video'" :key="contentUrl" :src="contentUrl" controls class="max-h-full w-full" @error="previewError = '视频加载失败'" />
            <template v-else-if="text">
              <div class="mb-2 flex items-center gap-3 text-small text-text-muted">
                <button class="text-accent disabled:opacity-40" :disabled="text.startLine <= 1" @click="loadText(Math.max(1, text.startLine - 400))">上一页</button>
                <span>{{ text.startLine }}–{{ text.endLine }} / {{ text.totalLines }} 行</span>
                <button class="text-accent disabled:opacity-40" :disabled="!text.truncated" @click="loadText(text.endLine + 1)">下一页</button>
              </div>
              <div class="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-small">
                <template v-for="(line, index) in text.content.split('\n')" :key="index">
                  <span class="select-none text-right text-text-subtle">{{ text.startLine + index }}</span><pre class="m-0 whitespace-pre">{{ line || ' ' }}</pre>
                </template>
              </div>
            </template>
          </div>
        </div>
      </template>
    </ResponsiveSplitPane>
  </div>
</template>

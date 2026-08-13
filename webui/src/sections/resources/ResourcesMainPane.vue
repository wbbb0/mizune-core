<script setup lang="ts">
import "@xterm/xterm/css/xterm.css";

import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { ChevronDown, ChevronUp, Circle, ClipboardPaste, Copy, Eraser, Files, Pause, Play, PlugZap, RefreshCw, Search, Square, Trash2, X, Zap } from "lucide-vue-next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchIconButton } from "@workbench-kit/vue";
import { openShellSocket, type ShellSession, type ShellSocketMessage } from "@/api/runtimeResources";
import { useResourcesSection } from "@/composables/sections/useResourcesSection";

const {
  selectedShell,
  selectedShellId,
  selectedDownload,
  selectedResourceKind,
  busy,
  error,
  refreshShells,
  refreshDownloads,
  closeShell,
  signalShell,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  removeDownload
} = useResourcesSection();

const terminalHost = ref<HTMLElement | null>(null);
const terminal = shallowRef<Terminal | null>(null);
const fitAddon = shallowRef<FitAddon | null>(null);
const searchAddon = shallowRef<SearchAddon | null>(null);
const webglAddon = shallowRef<WebglAddon | null>(null);
const socket = shallowRef<WebSocket | null>(null);
const attachedSession = ref<ShellSession | null>(null);
const connectionState = ref<"idle" | "connecting" | "open" | "closed" | "error">("idle");
const socketError = ref<string | null>(null);
const searchQuery = ref("");
const hasSelection = ref(false);
const terminalNotice = ref<string | null>(null);

let resizeObserver: ResizeObserver | null = null;
let observedTerminalHost: HTMLElement | null = null;
let fitTimer: number | null = null;
let terminalNoticeTimer: number | null = null;

const effectiveSession = computed(() => attachedSession.value ?? selectedShell.value);
const isDownloadView = computed(() => selectedResourceKind.value === "download");
const title = computed(() => isDownloadView.value
  ? selectedDownload.value?.source_name || "下载任务"
  : effectiveSession.value?.command || "运行时资源");
const statusLabel = computed(() => {
  if (!effectiveSession.value) return "未选择";
  if (effectiveSession.value.status === "closed") return "已关闭";
  if (connectionState.value === "open") return "已连接";
  if (connectionState.value === "connecting") return "连接中";
  if (connectionState.value === "error") return "连接异常";
  return "运行中";
});
const statusClass = computed(() => {
  if (effectiveSession.value?.status === "closed") return "text-text-subtle";
  if (connectionState.value === "open") return "text-success";
  if (connectionState.value === "error") return "text-danger";
  return "text-warning";
});

onMounted(() => {
  if (!isDownloadView.value) createTerminal();
  resizeObserver = new ResizeObserver(() => scheduleFit());
  if (terminalHost.value) {
    resizeObserver.observe(terminalHost.value);
  }
  if (selectedShellId.value) {
    void attachSelectedShell();
  }
});

onBeforeUnmount(() => {
  detachSocket();
  if (fitTimer != null) {
    window.clearTimeout(fitTimer);
    fitTimer = null;
  }
  if (terminalNoticeTimer != null) {
    window.clearTimeout(terminalNoticeTimer);
    terminalNoticeTimer = null;
  }
  resizeObserver?.disconnect();
  disposeTerminal();
});

watch(selectedShellId, () => {
  if (!isDownloadView.value) void attachSelectedShell();
});

watch(selectedResourceKind, async (kind) => {
  if (kind === "download") {
    detachSocket();
    disposeTerminal();
    return;
  }
  await nextTick();
  createTerminal();
  await attachSelectedShell();
});

watch(searchQuery, (value) => {
  if (!value) {
    searchAddon.value?.clearDecorations();
  }
});

function createTerminal() {
  if (!terminalHost.value) {
    return;
  }
  if (terminal.value && shouldRecreateTerminal()) {
    disposeTerminal();
  }
  if (terminal.value) {
    syncTerminalHostObservation();
    return;
  }
  syncTerminalHostObservation();
  const term = new Terminal({
    allowProposedApi: true,
    altClickMovesCursor: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    letterSpacing: 0,
    lineHeight: 1.25,
    macOptionClickForcesSelection: true,
    macOptionIsMeta: true,
    minimumContrastRatio: 4.5,
    overviewRuler: { width: 8 },
    rightClickSelectsWord: true,
    scrollOnUserInput: true,
    scrollback: 8000,
    theme: {
      background: "#0f1115",
      foreground: "#d7dde8",
      cursor: "#f5f7fb",
      selectionBackground: "#3b82f680"
    }
  });
  const fit = new FitAddon();
  const search = new SearchAddon({ highlightLimit: 1000 });
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon());
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (webglAddon.value === webgl) {
        webglAddon.value = null;
      }
    });
    term.loadAddon(webgl);
    webglAddon.value = webgl;
  } catch {
    webglAddon.value = null;
  }
  term.open(terminalHost.value);
  term.onData((data) => sendShellMessage({ kind: "input", data }));
  term.onSelectionChange(() => {
    hasSelection.value = Boolean(term.getSelection());
  });
  terminal.value = term;
  fitAddon.value = fit;
  searchAddon.value = search;
  scheduleFit();
}

async function attachSelectedShell() {
  detachSocket();
  attachedSession.value = selectedShell.value;
  socketError.value = null;
  terminal.value?.reset();
  hasSelection.value = false;

  const sessionId = selectedShellId.value;
  if (!sessionId) {
    connectionState.value = "idle";
    disposeTerminal();
    return;
  }

  await nextTick();
  createTerminal();
  connectionState.value = "connecting";
  const ws = openShellSocket(sessionId);
  socket.value = ws;

  ws.addEventListener("open", () => {
    connectionState.value = "open";
    scheduleFit();
  });
  ws.addEventListener("message", (event) => {
    if (socket.value !== ws) {
      return;
    }
    handleShellSocketMessage(String(event.data ?? ""));
  });
  ws.addEventListener("close", () => {
    if (socket.value === ws) {
      connectionState.value = connectionState.value === "error" ? "error" : "closed";
    }
  });
  ws.addEventListener("error", () => {
    if (socket.value === ws) {
      connectionState.value = "error";
      socketError.value = "WebSocket 连接失败";
    }
  });
}

function shouldRecreateTerminal(): boolean {
  const termElement = terminal.value?.element;
  return !termElement || !termElement.isConnected || !terminalHost.value?.contains(termElement);
}

function disposeTerminal() {
  terminal.value?.dispose();
  terminal.value = null;
  fitAddon.value = null;
  searchAddon.value = null;
  webglAddon.value = null;
  hasSelection.value = false;
}

function syncTerminalHostObservation() {
  if (!resizeObserver || observedTerminalHost === terminalHost.value) {
    return;
  }
  if (observedTerminalHost) {
    resizeObserver.unobserve(observedTerminalHost);
  }
  observedTerminalHost = terminalHost.value;
  if (observedTerminalHost) {
    resizeObserver.observe(observedTerminalHost);
  }
}

function detachSocket() {
  const current = socket.value;
  socket.value = null;
  if (current && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)) {
    current.close();
  }
}

function handleShellSocketMessage(raw: string) {
  const message = parseShellSocketMessage(raw);
  if (!message) {
    return;
  }
  if (message.kind === "hello") {
    attachedSession.value = message.session;
    terminal.value?.reset();
    if (message.replay) {
      terminal.value?.write(message.replay);
    }
    terminal.value?.focus();
    scheduleFit();
    return;
  }
  if (message.kind === "output") {
    terminal.value?.write(message.data);
    return;
  }
  if (message.kind === "status") {
    attachedSession.value = message.session;
    if (message.session.status === "closed") {
      void refreshShells();
    }
    return;
  }
  socketError.value = message.error;
}

function sendShellMessage(payload: unknown) {
  const current = socket.value;
  if (!current || current.readyState !== WebSocket.OPEN) {
    return;
  }
  current.send(JSON.stringify(payload));
}

function scheduleFit() {
  if (fitTimer != null) {
    window.clearTimeout(fitTimer);
  }
  fitTimer = window.setTimeout(() => {
    fitTimer = null;
    fitTerminal();
  }, 30);
}

function fitTerminal() {
  if (!terminal.value || !fitAddon.value || !terminalHost.value) {
    return;
  }
  fitAddon.value.fit();
  sendShellMessage({
    kind: "resize",
    cols: terminal.value.cols,
    rows: terminal.value.rows
  });
}

async function reconnect() {
  await attachSelectedShell();
}

async function sendSignal(signal: string) {
  const sessionId = effectiveSession.value?.id;
  if (!sessionId) {
    return;
  }
  await signalShell(sessionId, signal);
}

async function stopShell() {
  const sessionId = effectiveSession.value?.id;
  if (!sessionId) {
    return;
  }
  await closeShell(sessionId);
}

async function copyDownloadRef() {
  const value = selectedDownload.value?.asset_ref || selectedDownload.value?.resource_id;
  if (value) await writeClipboardText(value, "已复制资源引用");
}

function downloadStatusLabel(status: string) {
  return {
    running: "下载中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消"
  }[status] ?? status;
}

function downloadStatusClass(status: string) {
  if (status === "completed") return "text-success";
  if (status === "failed") return "text-danger";
  if (status === "running") return "text-warning";
  return "text-text-subtle";
}

function downloadPhaseLabel(phase: string) {
  return {
    queued: "排队中",
    probing: "探测资源",
    transferring: "传输中",
    finalizing: "写入完成",
    importing: "登记资源"
  }[phase] ?? phase;
}

function formatBytes(value: number | null) {
  if (value == null) return "未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function formatTime(value: number) {
  return new Date(value).toLocaleString();
}

function focusTerminal() {
  terminal.value?.focus();
}

function clearTerminal() {
  searchAddon.value?.clearDecorations();
  hasSelection.value = false;
  if (effectiveSession.value?.status === "running" && socket.value?.readyState === WebSocket.OPEN) {
    sendShellMessage({ kind: "input", data: "\x0c" });
  } else {
    terminal.value?.clear();
  }
  focusTerminal();
}

async function copySelection() {
  const selection = terminal.value?.getSelection() ?? "";
  if (!selection) {
    showTerminalNotice("没有选中内容");
    return;
  }
  await writeClipboardText(selection, "已复制选中内容");
}

async function copyScreen() {
  const term = terminal.value;
  if (!term) {
    return;
  }
  const text = collectTerminalText(term);
  if (!text) {
    showTerminalNotice("没有可复制内容");
    return;
  }
  await writeClipboardText(text, "已复制屏幕内容");
}

async function pasteFromClipboard() {
  const term = terminal.value;
  if (!term) {
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      term.paste(text);
      focusTerminal();
    }
  } catch (clipboardError) {
    showTerminalNotice(clipboardError instanceof Error ? clipboardError.message : String(clipboardError));
  }
}

function findNext() {
  findInTerminal("next");
}

function findPrevious() {
  findInTerminal("previous");
}

function findInTerminal(direction: "next" | "previous") {
  const query = searchQuery.value;
  const search = searchAddon.value;
  if (!query || !search) {
    search?.clearDecorations();
    return;
  }
  const options = {
    decorations: {
      matchBackground: "#1f3a5f",
      matchOverviewRuler: "#60a5fa",
      activeMatchBackground: "#b45309",
      activeMatchColorOverviewRuler: "#f59e0b"
    }
  };
  const found = direction === "next"
    ? search.findNext(query, options)
    : search.findPrevious(query, options);
  if (!found) {
    showTerminalNotice("未找到");
  }
  focusTerminal();
}

function collectTerminalText(term: Terminal): string {
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.baseY - 8000);
  const end = buffer.baseY + term.rows;
  const lines: string[] = [];
  for (let row = start; row < end; row += 1) {
    const line = buffer.getLine(row);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  return lines.join("\n").trimEnd();
}

async function writeClipboardText(text: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(text);
    showTerminalNotice(successMessage);
    focusTerminal();
  } catch (clipboardError) {
    showTerminalNotice(clipboardError instanceof Error ? clipboardError.message : String(clipboardError));
  }
}

function showTerminalNotice(message: string) {
  terminalNotice.value = message;
  if (terminalNoticeTimer != null) {
    window.clearTimeout(terminalNoticeTimer);
  }
  terminalNoticeTimer = window.setTimeout(() => {
    terminalNotice.value = null;
    terminalNoticeTimer = null;
  }, 1800);
}

function parseShellSocketMessage(raw: string): ShellSocketMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind === "hello" && isShellSession(record.session) && typeof record.replay === "string") {
    return { kind: "hello", session: record.session, replay: record.replay };
  }
  if (record.kind === "output" && typeof record.data === "string") {
    return { kind: "output", data: record.data };
  }
  if (record.kind === "status" && isShellSession(record.session)) {
    return { kind: "status", session: record.session };
  }
  if (record.kind === "error" && typeof record.error === "string") {
    return { kind: "error", error: record.error };
  }
  return null;
}

function isShellSession(value: unknown): value is ShellSession {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <WorkbenchAreaHeader :title="title">
      <template #actions>
        <template v-if="isDownloadView">
          <WorkbenchIconButton :icon="Pause" :disabled="!selectedDownload || selectedDownload.status !== 'running' || busy" title="暂停" @click="selectedDownload && pauseDownload(selectedDownload.resource_id)" />
          <WorkbenchIconButton :icon="Play" :disabled="!selectedDownload || !(selectedDownload.status === 'paused' || selectedDownload.status === 'failed' && selectedDownload.retryable) || busy" title="恢复" @click="selectedDownload && resumeDownload(selectedDownload.resource_id)" />
          <WorkbenchIconButton :icon="X" :disabled="!selectedDownload || !['running', 'paused', 'failed'].includes(selectedDownload.status) || busy" title="取消" @click="selectedDownload && cancelDownload(selectedDownload.resource_id)" />
          <WorkbenchIconButton :icon="Trash2" :disabled="!selectedDownload || selectedDownload.status === 'running' || busy" title="移除记录" @click="selectedDownload && removeDownload(selectedDownload.resource_id)" />
          <WorkbenchIconButton :icon="RefreshCw" :disabled="busy" title="刷新" @click="refreshDownloads" />
        </template>
        <template v-else>
          <WorkbenchIconButton :icon="PlugZap" :disabled="!selectedShellId" title="重连" @click="reconnect" />
          <WorkbenchIconButton :icon="Zap" :disabled="!effectiveSession || effectiveSession.status !== 'running' || busy" title="SIGINT" @click="sendSignal('SIGINT')" />
          <WorkbenchIconButton :icon="Square" :disabled="!effectiveSession || effectiveSession.status !== 'running' || busy" title="停止" @click="stopShell" />
          <WorkbenchIconButton :icon="RefreshCw" :disabled="busy" title="刷新" @click="refreshShells" />
        </template>
      </template>
    </WorkbenchAreaHeader>

    <div v-if="isDownloadView && selectedDownload" class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
      <div class="mx-auto grid max-w-4xl gap-5">
        <section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
          <div class="flex items-center gap-3">
            <span class="inline-flex items-center gap-1.5 text-small font-medium" :class="downloadStatusClass(selectedDownload.status)">
              <Circle :size="9" fill="currentColor" :stroke-width="0" />
              {{ downloadStatusLabel(selectedDownload.status) }}
            </span>
            <span class="text-small text-text-subtle">{{ downloadPhaseLabel(selectedDownload.phase) }}</span>
            <span class="ml-auto font-mono text-small text-text-muted">{{ selectedDownload.percent ?? 0 }}%</span>
          </div>
          <div class="mt-3 h-2 overflow-hidden rounded-full bg-surface-muted">
            <div class="h-full rounded-full bg-accent transition-[width]" :style="{ width: `${selectedDownload.percent ?? 0}%` }" />
          </div>
          <div class="mt-2 flex justify-between gap-3 text-small text-text-subtle">
            <span>{{ formatBytes(selectedDownload.downloaded_bytes) }}</span>
            <span>{{ formatBytes(selectedDownload.total_bytes) }}</span>
          </div>
        </section>

        <section class="grid gap-3 rounded-lg border border-border-subtle bg-surface-raised p-4 text-small">
          <div class="grid gap-1">
            <span class="text-text-muted">来源 URL</span>
            <a :href="selectedDownload.source_url" target="_blank" rel="noreferrer" class="break-all text-accent hover:underline">{{ selectedDownload.source_url }}</a>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div><span class="text-text-muted">任务 ID</span><div class="mt-1 break-all font-mono">{{ selectedDownload.resource_id }}</div></div>
            <div><span class="text-text-muted">并发</span><div class="mt-1">{{ selectedDownload.concurrency }}</div></div>
            <div><span class="text-text-muted">创建时间</span><div class="mt-1">{{ formatTime(selectedDownload.created_at_ms) }}</div></div>
            <div><span class="text-text-muted">更新时间</span><div class="mt-1">{{ formatTime(selectedDownload.updated_at_ms) }}</div></div>
            <div><span class="text-text-muted">类型</span><div class="mt-1">{{ selectedDownload.mime_type || selectedDownload.kind || '未知' }}</div></div>
            <div><span class="text-text-muted">可重试</span><div class="mt-1">{{ selectedDownload.retryable ? '是' : '否' }}</div></div>
          </div>
        </section>

        <section v-if="selectedDownload.asset_ref" class="flex items-center gap-3 rounded-lg border border-success/30 bg-success/5 p-4">
          <div class="min-w-0 flex-1">
            <div class="text-small text-text-muted">已登记 Asset</div>
            <div class="mt-1 truncate font-mono text-small">{{ selectedDownload.asset_ref }}</div>
          </div>
          <button class="btn h-8 gap-1.5" @click="copyDownloadRef"><Copy :size="13" />复制引用</button>
        </section>

        <div v-if="selectedDownload.error || error" class="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-small text-danger">
          {{ selectedDownload.error || error }}
        </div>
      </div>
    </div>

    <div v-else-if="!isDownloadView && effectiveSession" class="flex min-h-0 flex-1 flex-col">
      <div class="flex min-h-9 items-center gap-3 border-b border-border-subtle px-4 text-small">
        <span class="shrink-0 inline-flex items-center gap-1.5" :class="statusClass">
          <Circle :size="9" fill="currentColor" :stroke-width="0" />
          {{ statusLabel }}
        </span>
        <span class="shrink truncate font-mono text-text-subtle" :title="effectiveSession.cwd">{{ effectiveSession.cwd }}</span>
        <span v-if="effectiveSession.pid" class="ml-auto shrink-0 font-mono text-text-muted">pid {{ effectiveSession.pid }}</span>
        <span v-else-if="effectiveSession.exitCode !== null" class="ml-auto shrink-0 font-mono text-text-muted">exit {{ effectiveSession.exitCode }}</span>
      </div>

      <div class="flex min-h-10 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <div class="flex min-w-[180px] flex-1 items-center gap-1.5">
          <Search :size="14" :stroke-width="2" class="shrink-0 text-text-muted" />
          <input
            v-model="searchQuery"
            class="input-base h-7 min-w-0 flex-1 text-small"
            placeholder="搜索输出"
            @keydown.enter.prevent="findNext"
            @keydown.shift.enter.prevent="findPrevious"
          >
          <WorkbenchIconButton size="sm" :icon="ChevronUp" :disabled="!searchQuery" title="上一个" @click="findPrevious" />
          <WorkbenchIconButton size="sm" :icon="ChevronDown" :disabled="!searchQuery" title="下一个" @click="findNext" />
        </div>

        <div class="flex items-center gap-1">
          <WorkbenchIconButton size="sm" :icon="Copy" :disabled="!hasSelection" title="复制选中内容" @click="copySelection" />
          <WorkbenchIconButton size="sm" :icon="Files" :disabled="!terminal" title="复制屏幕内容" @click="copyScreen" />
          <WorkbenchIconButton size="sm" :icon="ClipboardPaste" :disabled="!terminal || effectiveSession.status !== 'running'" title="粘贴" @click="pasteFromClipboard" />
          <WorkbenchIconButton size="sm" :icon="Eraser" :disabled="!terminal" title="发送 Ctrl-L" @click="clearTerminal" />
        </div>

        <span v-if="terminalNotice" class="min-w-0 truncate text-small text-text-subtle">{{ terminalNotice }}</span>
      </div>

      <div v-if="socketError || error" class="border-b border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-surface-danger px-4 py-2 text-small text-danger">
        {{ socketError || error }}
      </div>

      <div ref="terminalHost" class="min-h-0 flex-1 overflow-hidden bg-[#0f1115]" @click="focusTerminal" />
    </div>

    <WorkbenchEmptyState v-else :message="isDownloadView ? '← 选择或新建一个下载任务' : '← 选择或新建一个 Shell 资源'" />
  </div>
</template>

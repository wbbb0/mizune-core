import { computed, ref } from "vue";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";
import {
  runtimeResourcesApi,
  type DownloadStartRequest,
  type DownloadTask,
  type ShellSession
} from "@/api/runtimeResources";
import { useWorkbenchNavigation } from "@workbench-kit/vue";

const shellSessions = ref<ShellSession[]>([]);
const selectedShellId = ref<string | null>(null);
const downloadTasks = ref<DownloadTask[]>([]);
const selectedDownloadId = ref<string | null>(null);
const selectedResourceKind = ref<"shell" | "download">("shell");
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const selectedShell = computed(() => shellSessions.value.find((item) => item.id === selectedShellId.value) ?? null);
const selectedDownload = computed(() => downloadTasks.value.find((item) => item.resource_id === selectedDownloadId.value) ?? null);

type ResourcesSectionState = {
  shellSessions: typeof shellSessions;
  selectedShellId: typeof selectedShellId;
  selectedShell: typeof selectedShell;
  downloadTasks: typeof downloadTasks;
  selectedDownloadId: typeof selectedDownloadId;
  selectedDownload: typeof selectedDownload;
  selectedResourceKind: typeof selectedResourceKind;
  loading: typeof loading;
  busy: typeof busy;
  error: typeof error;
  resetState: () => void;
  refreshShells: () => Promise<void>;
  refreshDownloads: () => Promise<void>;
  refreshResources: () => Promise<void>;
  selectShell: (sessionId: string) => void;
  selectDownload: (resourceId: string) => void;
  createShell: (input?: { command?: string; cwd?: string }) => Promise<void>;
  closeShell: (sessionId: string) => Promise<void>;
  signalShell: (sessionId: string, signal: string) => Promise<void>;
  startDownload: (input: DownloadStartRequest) => Promise<void>;
  pauseDownload: (resourceId: string) => Promise<void>;
  resumeDownload: (resourceId: string) => Promise<void>;
  cancelDownload: (resourceId: string) => Promise<void>;
  removeDownload: (resourceId: string) => Promise<void>;
};

export const useResourcesSection = createSharedSectionState<ResourcesSectionState>(() => {
  const workbenchNavigation = useWorkbenchNavigation();

  function resetState() {
    shellSessions.value = [];
    selectedShellId.value = null;
    downloadTasks.value = [];
    selectedDownloadId.value = null;
    selectedResourceKind.value = "shell";
    loading.value = false;
    busy.value = false;
    error.value = null;
  }

  async function refreshDownloads() {
    error.value = null;
    try {
      const result = await runtimeResourcesApi.listDownloads();
      downloadTasks.value = result.tasks.sort((left, right) => right.updated_at_ms - left.updated_at_ms);
      if (selectedDownloadId.value && !downloadTasks.value.some((item) => item.resource_id === selectedDownloadId.value)) {
        selectedDownloadId.value = downloadTasks.value[0]?.resource_id ?? null;
      }
    } catch (refreshError) {
      error.value = refreshError instanceof Error ? refreshError.message : String(refreshError);
    }
  }

  async function refreshResources() {
    loading.value = true;
    try {
      await Promise.all([refreshShells(), refreshDownloads()]);
    } finally {
      loading.value = false;
    }
  }

  async function refreshShells() {
    loading.value = true;
    error.value = null;
    try {
      const result = await runtimeResourcesApi.listShellSessions();
      shellSessions.value = result.sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      if (!selectedShellId.value && shellSessions.value[0]) {
        selectedShellId.value = shellSessions.value[0].id;
      }
      if (selectedShellId.value && !shellSessions.value.some((item) => item.id === selectedShellId.value)) {
        selectedShellId.value = shellSessions.value[0]?.id ?? null;
      }
    } catch (refreshError) {
      error.value = refreshError instanceof Error ? refreshError.message : String(refreshError);
    } finally {
      loading.value = false;
    }
  }

  function selectShell(sessionId: string) {
    selectedShellId.value = sessionId;
    selectedResourceKind.value = "shell";
  }

  function selectDownload(resourceId: string) {
    selectedDownloadId.value = resourceId;
    selectedResourceKind.value = "download";
    workbenchNavigation.showArea("mainArea");
  }

  async function startDownload(input: DownloadStartRequest) {
    busy.value = true;
    error.value = null;
    try {
      const result = await runtimeResourcesApi.startDownload(input);
      await refreshDownloads();
      selectedDownloadId.value = result.task.resource_id;
      selectedResourceKind.value = "download";
      workbenchNavigation.showArea("mainArea");
    } catch (startError) {
      error.value = startError instanceof Error ? startError.message : String(startError);
    } finally {
      busy.value = false;
    }
  }

  async function mutateDownload(resourceId: string, operation: "pause" | "resume" | "cancel") {
    busy.value = true;
    error.value = null;
    try {
      const result = operation === "pause"
        ? await runtimeResourcesApi.pauseDownload(resourceId)
        : operation === "resume"
          ? await runtimeResourcesApi.resumeDownload(resourceId)
          : await runtimeResourcesApi.cancelDownload(resourceId);
      const index = downloadTasks.value.findIndex((item) => item.resource_id === resourceId);
      if (index >= 0) downloadTasks.value[index] = result.task;
      await refreshDownloads();
    } catch (mutationError) {
      error.value = mutationError instanceof Error ? mutationError.message : String(mutationError);
    } finally {
      busy.value = false;
    }
  }

  const pauseDownload = (resourceId: string) => mutateDownload(resourceId, "pause");
  const resumeDownload = (resourceId: string) => mutateDownload(resourceId, "resume");
  const cancelDownload = (resourceId: string) => mutateDownload(resourceId, "cancel");

  async function removeDownload(resourceId: string) {
    busy.value = true;
    error.value = null;
    try {
      await runtimeResourcesApi.removeDownload(resourceId);
      if (selectedDownloadId.value === resourceId) selectedDownloadId.value = null;
      await refreshDownloads();
    } catch (removeError) {
      error.value = removeError instanceof Error ? removeError.message : String(removeError);
    } finally {
      busy.value = false;
    }
  }

  async function createShell(input: { command?: string; cwd?: string } = {}) {
    busy.value = true;
    error.value = null;
    const command = input.command?.trim() || "zsh";
    try {
      const result = await runtimeResourcesApi.runShell({
        command,
        ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
        description: "WebUI 交互终端",
        tty: true,
        background: true,
        timeoutMs: 1000
      });
      const resourceId = parseShellResourceId(result.result);
      await refreshShells();
      if (resourceId) {
        selectedShellId.value = resourceId;
        selectedResourceKind.value = "shell";
        workbenchNavigation.showArea("mainArea");
      }
    } catch (createError) {
      error.value = createError instanceof Error ? createError.message : String(createError);
    } finally {
      busy.value = false;
    }
  }

  async function closeShell(sessionId: string) {
    busy.value = true;
    error.value = null;
    try {
      await runtimeResourcesApi.closeShell(sessionId);
      await refreshShells();
    } catch (closeError) {
      error.value = closeError instanceof Error ? closeError.message : String(closeError);
    } finally {
      busy.value = false;
    }
  }

  async function signalShell(sessionId: string, signal: string) {
    busy.value = true;
    error.value = null;
    try {
      await runtimeResourcesApi.signalShell(sessionId, signal);
      await refreshShells();
    } catch (signalError) {
      error.value = signalError instanceof Error ? signalError.message : String(signalError);
    } finally {
      busy.value = false;
    }
  }

  void refreshResources();

  return {
    shellSessions,
    selectedShellId,
    selectedShell,
    downloadTasks,
    selectedDownloadId,
    selectedDownload,
    selectedResourceKind,
    loading,
    busy,
    error,
    resetState,
    refreshShells,
    refreshDownloads,
    refreshResources,
    selectShell,
    selectDownload,
    createShell,
    closeShell,
    signalShell,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    removeDownload
  };
});

function parseShellResourceId(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as Record<string, unknown>;
  return typeof record.resourceId === "string"
    ? record.resourceId
    : typeof record.resource_id === "string"
      ? record.resource_id
      : null;
}

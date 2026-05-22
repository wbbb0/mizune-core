import { computed, ref } from "vue";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";
import { runtimeResourcesApi, type ShellSession } from "@/api/runtimeResources";
import { useWorkbenchNavigation } from "@workbench-kit/vue-workbench";

const shellSessions = ref<ShellSession[]>([]);
const selectedShellId = ref<string | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const selectedShell = computed(() => shellSessions.value.find((item) => item.id === selectedShellId.value) ?? null);
const mobileHeaderTitle = computed(() => selectedShell.value?.command || "运行时资源");

type ResourcesSectionState = {
  shellSessions: typeof shellSessions;
  selectedShellId: typeof selectedShellId;
  selectedShell: typeof selectedShell;
  loading: typeof loading;
  busy: typeof busy;
  error: typeof error;
  mobileHeaderTitle: typeof mobileHeaderTitle;
  resetState: () => void;
  refreshShells: () => Promise<void>;
  selectShell: (sessionId: string) => void;
  createShell: (input?: { command?: string; cwd?: string }) => Promise<void>;
  closeShell: (sessionId: string) => Promise<void>;
  signalShell: (sessionId: string, signal: string) => Promise<void>;
};

export const useResourcesSection = createSharedSectionState<ResourcesSectionState>(() => {
  const workbenchNavigation = useWorkbenchNavigation();

  function resetState() {
    shellSessions.value = [];
    selectedShellId.value = null;
    loading.value = false;
    busy.value = false;
    error.value = null;
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
    workbenchNavigation.showArea("mainArea");
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

  void refreshShells();

  return {
    shellSessions,
    selectedShellId,
    selectedShell,
    loading,
    busy,
    error,
    mobileHeaderTitle,
    resetState,
    refreshShells,
    selectShell,
    createShell,
    closeShell,
    signalShell
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

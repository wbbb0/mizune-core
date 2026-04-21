import { computed, ref, type ComputedRef, type Ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { ApiError } from "@/api/client";
import { sessionsApi } from "@/api/sessions";
import type { SessionDetailResult } from "@/api/types";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";
import { useSessionsStore } from "@/stores/sessions";
import type { NormalizedSessionListItem } from "@/stores/sessionDisplay";

type CreateSessionPayload = {
  title?: string;
  modeId?: string;
};

type SessionsSectionState = {
  store: ReturnType<typeof useSessionsStore>;
  loading: Ref<boolean>;
  createDialogOpen: Ref<boolean>;
  createDialogBusy: Ref<boolean>;
  createDialogError: Ref<string>;
  actionsDialogSessionId: Ref<string | null>;
  actionsDialogBusy: Ref<boolean>;
  actionsDialogError: Ref<string>;
  actionsDialogTitleDraft: Ref<string>;
  actionsDialogDetail: Ref<SessionDetailResult["session"] | null>;
  actionsSession: ComputedRef<NormalizedSessionListItem | null>;
  actionsSessionTitleSource: ComputedRef<"default" | "auto" | "manual" | null>;
  actionsDialogTitleGenerationAvailable: ComputedRef<boolean>;
  actionsDialogSupportsTitleEditing: ComputedRef<boolean>;
  actionsDialogTitleSourceLabel: ComputedRef<string>;
  mobileHeaderTitle: ComputedRef<string>;
  initializeSection: () => Promise<void>;
  resetState: () => void;
  selectSession: (sessionId: string) => void;
  refreshSessions: () => Promise<void>;
  openCreateDialog: () => void;
  closeCreateDialog: () => void;
  submitCreateSession: (payload: CreateSessionPayload) => Promise<void>;
  openSessionActions: (sessionId: string) => void;
  closeSessionActions: () => void;
  saveSessionTitle: () => Promise<void>;
  regenerateSessionTitle: () => Promise<void>;
  switchSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  modeSupportsCurrentSession: (modeId: string) => boolean;
};

let sharedState: SessionsSectionState | null = null;

export function useSessionsSection() {
  if (!sharedState) {
    const store = useSessionsStore();
    const workbenchRuntime = useWorkbenchRuntime();
    const loading = ref(false);
    const createDialogOpen = ref(false);
    const createDialogBusy = ref(false);
    const createDialogError = ref("");
    const actionsDialogSessionId = ref<string | null>(null);
    const actionsDialogBusy = ref(false);
    const actionsDialogError = ref("");
    const actionsDialogTitleDraft = ref("");
    const actionsDialogDetail = ref<SessionDetailResult["session"] | null>(null);
    const initialized = ref(false);
    let stateVersion = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const actionsSession = computed(() => (
      store.list.find((item) => item.id === actionsDialogSessionId.value) ?? null
    ));
    const actionsSessionTitleSource = computed(() => (
      actionsDialogDetail.value?.titleSource ?? actionsSession.value?.titleSource ?? null
    ));
    const actionsDialogTitleGenerationAvailable = computed(() => (
      actionsDialogDetail.value?.titleGenerationAvailable === true
    ));
    const actionsDialogSupportsTitleEditing = computed(() => (
      actionsSession.value?.source === "web"
    ));
    const actionsDialogTitleSourceLabel = computed(() => (
      actionsSessionTitleSource.value === "manual"
        ? "手动设置"
        : actionsSessionTitleSource.value === "auto"
          ? "自动生成"
          : "默认标题"
    ));
    const mobileHeaderTitle = computed(() => (
      store.active?.displayLabel || store.active?.id || ""
    ));

    function isStale(requestVersion: number) {
      return requestVersion !== stateVersion;
    }

    function syncActionsTitleDraft() {
      actionsDialogTitleDraft.value = actionsDialogDetail.value?.title ?? actionsSession.value?.title ?? "";
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function startPolling() {
      stopPolling();
      pollTimer = setInterval(() => {
        if (!store.active || store.active.streamStatus !== "connected") {
          void refreshSessions();
        }
      }, 10_000);
    }

    function resetState() {
      stateVersion += 1;
      initialized.value = false;
      stopPolling();
      loading.value = false;
      createDialogOpen.value = false;
      createDialogBusy.value = false;
      createDialogError.value = "";
      actionsDialogSessionId.value = null;
      actionsDialogBusy.value = false;
      actionsDialogError.value = "";
      actionsDialogTitleDraft.value = "";
      actionsDialogDetail.value = null;
      store.deselectSession();
    }

    async function refreshSessions() {
      const requestVersion = stateVersion;
      loading.value = true;
      try {
        await store.refresh();
      } finally {
        if (!isStale(requestVersion)) {
          loading.value = false;
        }
      }
    }

    async function initializeSection() {
      if (initialized.value) {
        return;
      }
      initialized.value = true;
      const requestVersion = stateVersion;
      await refreshSessions();
      if (!isStale(requestVersion)) {
        startPolling();
      }
    }

    function selectSession(sessionId: string) {
      store.selectSession(sessionId);
      workbenchRuntime.showMain();
    }

    function openCreateDialog() {
      createDialogError.value = "";
      createDialogOpen.value = true;
    }

    function closeCreateDialog() {
      if (createDialogBusy.value) {
        return;
      }
      createDialogOpen.value = false;
      createDialogError.value = "";
    }

    async function submitCreateSession(payload: CreateSessionPayload) {
      const requestVersion = stateVersion;
      createDialogBusy.value = true;
      createDialogError.value = "";
      try {
        await store.createSession(payload);
        if (isStale(requestVersion)) {
          return;
        }
        createDialogOpen.value = false;
        createDialogError.value = "";
        workbenchRuntime.showMain();
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        createDialogError.value = error instanceof Error ? error.message : "创建会话失败";
      } finally {
        if (!isStale(requestVersion)) {
          createDialogBusy.value = false;
        }
      }
    }

    async function loadActionsDialogDetail(sessionId: string) {
      const requestVersion = stateVersion;
      syncActionsTitleDraft();
      if (actionsSession.value?.source !== "web") {
        actionsDialogDetail.value = null;
        return;
      }
      try {
        const detail = await sessionsApi.fetchDetail(sessionId);
        if (isStale(requestVersion) || actionsDialogSessionId.value !== sessionId) {
          return;
        }
        actionsDialogDetail.value = detail.session;
        syncActionsTitleDraft();
      } catch (error: unknown) {
        if (isStale(requestVersion) || actionsDialogSessionId.value !== sessionId) {
          return;
        }
        actionsDialogError.value = error instanceof ApiError || error instanceof Error
          ? error.message
          : "载入会话详情失败";
      }
    }

    function openSessionActions(sessionId: string) {
      actionsDialogSessionId.value = sessionId;
      actionsDialogError.value = "";
      actionsDialogDetail.value = null;
      syncActionsTitleDraft();
      void loadActionsDialogDetail(sessionId);
    }

    function closeSessionActions() {
      if (actionsDialogBusy.value) {
        return;
      }
      actionsDialogSessionId.value = null;
      actionsDialogError.value = "";
      actionsDialogTitleDraft.value = "";
      actionsDialogDetail.value = null;
    }

    async function saveSessionTitle() {
      const requestVersion = stateVersion;
      if (!actionsDialogSessionId.value || !actionsDialogSupportsTitleEditing.value || actionsDialogBusy.value) {
        return;
      }
      actionsDialogBusy.value = true;
      actionsDialogError.value = "";
      try {
        const result = await store.renameSessionTitle(actionsDialogSessionId.value, actionsDialogTitleDraft.value);
        if (isStale(requestVersion) || actionsDialogSessionId.value !== result.id) {
          return;
        }
        actionsDialogDetail.value = actionsDialogDetail.value
          ? {
              ...actionsDialogDetail.value,
              title: result.title,
              titleSource: result.titleSource
            }
          : null;
        syncActionsTitleDraft();
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        actionsDialogError.value = error instanceof ApiError || error instanceof Error
          ? error.message
          : "保存标题失败";
      } finally {
        if (!isStale(requestVersion)) {
          actionsDialogBusy.value = false;
        }
      }
    }

    async function regenerateSessionTitle() {
      const requestVersion = stateVersion;
      if (
        !actionsDialogSessionId.value
        || !actionsDialogSupportsTitleEditing.value
        || !actionsDialogTitleGenerationAvailable.value
        || actionsDialogBusy.value
      ) {
        return;
      }
      actionsDialogBusy.value = true;
      actionsDialogError.value = "";
      try {
        const result = await store.regenerateSessionTitle(actionsDialogSessionId.value);
        if (isStale(requestVersion) || actionsDialogSessionId.value !== result.id) {
          return;
        }
        actionsDialogDetail.value = actionsDialogDetail.value
          ? {
              ...actionsDialogDetail.value,
              title: result.title,
              titleSource: result.titleSource
            }
          : null;
        syncActionsTitleDraft();
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        actionsDialogError.value = error instanceof ApiError || error instanceof Error
          ? error.message
          : "重新生成标题失败";
      } finally {
        if (!isStale(requestVersion)) {
          actionsDialogBusy.value = false;
        }
      }
    }

    async function switchSessionMode(sessionId: string, modeId: string) {
      const requestVersion = stateVersion;
      actionsDialogBusy.value = true;
      actionsDialogError.value = "";
      try {
        await store.switchSessionMode(sessionId, modeId);
        if (isStale(requestVersion)) {
          return;
        }
        actionsDialogSessionId.value = null;
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        actionsDialogError.value = error instanceof ApiError || error instanceof Error
          ? error.message
          : "切换模式失败";
      } finally {
        if (!isStale(requestVersion)) {
          actionsDialogBusy.value = false;
        }
      }
    }

    async function deleteSession(sessionId: string) {
      const requestVersion = stateVersion;
      actionsDialogBusy.value = true;
      actionsDialogError.value = "";
      try {
        await store.deleteSession(sessionId);
        if (isStale(requestVersion)) {
          return;
        }
        actionsDialogSessionId.value = null;
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        actionsDialogError.value = error instanceof ApiError || error instanceof Error
          ? error.message
          : "删除会话失败";
      } finally {
        if (!isStale(requestVersion)) {
          actionsDialogBusy.value = false;
        }
      }
    }

    function modeSupportsCurrentSession(modeId: string): boolean {
      const session = actionsSession.value;
      const mode = store.modes.find((item) => item.id === modeId);
      if (!session || !mode?.allowedChatTypes || mode.allowedChatTypes.length === 0) {
        return true;
      }
      return mode.allowedChatTypes.includes(session.type);
    }

    sharedState = {
      store,
      loading,
      createDialogOpen,
      createDialogBusy,
      createDialogError,
      actionsDialogSessionId,
      actionsDialogBusy,
      actionsDialogError,
      actionsDialogTitleDraft,
      actionsDialogDetail,
      actionsSession,
      actionsSessionTitleSource,
      actionsDialogTitleGenerationAvailable,
      actionsDialogSupportsTitleEditing,
      actionsDialogTitleSourceLabel,
      mobileHeaderTitle,
      initializeSection,
      resetState,
      selectSession,
      refreshSessions,
      openCreateDialog,
      closeCreateDialog,
      submitCreateSession,
      openSessionActions,
      closeSessionActions,
      saveSessionTitle,
      regenerateSessionTitle,
      switchSessionMode,
      deleteSession,
      modeSupportsCurrentSession
    };
  }

  onBeforeRouteLeave(() => {
    sharedState?.resetState();
  });

  return sharedState;
}

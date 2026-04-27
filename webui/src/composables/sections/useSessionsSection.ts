import { computed, ref, type ComputedRef, type Ref } from "vue";
import { ApiError } from "@/api/client";
import { sessionsApi } from "@/api/sessions";
import type { SessionDetailResult } from "@/api/types";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";
import { useWorkbenchNavigation } from "@/components/workbench/runtime/workbenchRuntime";
import { useWorkbenchWindows } from "@/composables/workbench/useWorkbenchWindows";
import { openCreateSessionWindow } from "@/components/sessions/createSessionWindow";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkbenchToasts } from "@/components/workbench/toasts/useWorkbenchToasts";
import type { NormalizedSessionListItem } from "@/stores/sessionDisplay";
import { createSessionWindowContext } from "@/components/sessions/sessionWindowContext";

type CreateSessionPayload = {
  title?: string;
  modeId?: string;
};

const CANCEL_WINDOW_ACTION = Symbol("cancel-window-action");

type SessionsSectionState = {
  store: ReturnType<typeof useSessionsStore>;
  loading: Ref<boolean>;
  mobileHeaderTitle: ComputedRef<string>;
  initializeSection: () => Promise<void>;
  resetState: () => void;
  selectSession: (sessionId: string) => void;
  refreshSessions: () => Promise<void>;
  openCreateDialog: () => Promise<void>;
  openSessionActions: (sessionId: string) => Promise<void>;
};

export const useSessionsSection = createSharedSectionState<SessionsSectionState>(() => {
    const store = useSessionsStore();
    const workbenchNavigation = useWorkbenchNavigation();
    const windows = useWorkbenchWindows();
    const toast = useWorkbenchToasts();
    const loading = ref(false);
    const initialized = ref(false);
    let stateVersion = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const mobileHeaderTitle = computed(() => (
      store.active?.displayLabel || store.active?.id || ""
    ));

    function isStale(requestVersion: number) {
      return requestVersion !== stateVersion;
    }

    function reportError(error: unknown, fallback: string) {
      const message = error instanceof ApiError || error instanceof Error
        ? error.message
        : fallback;
      toast.push({ type: "error", message });
    }

    function resolveSessionModeLabel(session: NormalizedSessionListItem, modeId: string) {
      const mode = store.modes.find((item) => item.id === modeId);
      if (!mode) {
        return modeId;
      }
      return mode.allowedChatTypes && mode.allowedChatTypes.length > 0 && !mode.allowedChatTypes.includes(session.type)
        ? `${mode.title}（当前会话类型不支持）`
        : mode.title;
    }

    function modeSupportsSession(session: NormalizedSessionListItem, modeId: string): boolean {
      const mode = store.modes.find((item) => item.id === modeId);
      if (!mode?.allowedChatTypes || mode.allowedChatTypes.length === 0) {
        return true;
      }
      return mode.allowedChatTypes.includes(session.type);
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
      workbenchNavigation.showMain();
    }

    async function openCreateDialog() {
      await openCreateSessionWindow({
        windows,
        modes: store.modes.map((mode) => ({
          id: mode.id,
          title: mode.title,
          description: mode.description
        })),
        submit: async (payload: CreateSessionPayload) => {
          const requestVersion = stateVersion;
          await store.createSession(payload);
          if (!isStale(requestVersion)) {
            workbenchNavigation.showMain();
          }
        },
        reportError: (error) => {
          reportError(error, "创建会话失败");
        }
      });
    }

    async function openSessionActions(sessionId: string) {
      const session = store.list.find((item) => item.id === sessionId);
      if (!session) {
        return;
      }

      let detail: SessionDetailResult["session"] | null = null;
      if (session.source === "web") {
        try {
          detail = (await sessionsApi.fetchDetail(sessionId)).session;
        } catch (error: unknown) {
          reportError(error, "载入会话详情失败");
        }
      }

      const supportsTitleEditing = session.source === "web";
      const titleGenerationAvailable = detail?.titleGenerationAvailable === true;
      const titleSourceLabel = detail?.titleSource === "manual"
        ? "手动设置"
        : detail?.titleSource === "auto"
          ? "自动生成"
          : "默认标题";

      await windows.open({
        kind: "dialog",
        title: "会话操作",
        description: "管理标题、切换当前会话模式，或删除该会话。",
        size: "lg",
        modal: true,
        context: createSessionWindowContext(sessionId),
        schema: {
          fields: [
            ...(supportsTitleEditing
              ? [{
                  kind: "string" as const,
                  key: "title",
                  label: "标题",
                  defaultValue: detail?.title ?? session.title ?? "",
                  placeholder: "输入会话标题"
                }]
              : []),
            {
              kind: "enum" as const,
              key: "modeId",
              label: "会话模式",
              defaultValue: session.modeId,
              options: store.modes.map((mode) => ({
                label: resolveSessionModeLabel(session, mode.id),
                value: mode.id
              }))
            }
          ]
        },
        blocks: [
          ...(supportsTitleEditing
            ? [{
                kind: "text" as const,
                content: `标题来源：${titleSourceLabel}${titleGenerationAvailable ? "" : "；标题生成器不可用"}`
              }]
            : []),
          {
            kind: "text" as const,
            content: "切换模式会立即影响当前会话的后续行为。删除会话不可恢复。"
          }
        ],
        actions: [
          ...(supportsTitleEditing
            ? [{
                id: "rename",
                label: "保存标题",
                variant: "secondary" as const,
                run: async ({ values }: { values: Record<string, unknown> }) => {
                  try {
                    await store.renameSessionTitle(sessionId, String(values.title ?? ""));
                    return { sessionId };
                  } catch (error: unknown) {
                    reportError(error, "保存标题失败");
                    throw error;
                  }
                }
              }]
            : []),
          ...(supportsTitleEditing && titleGenerationAvailable
            ? [{
                id: "regenerate",
                label: "重新生成标题",
                variant: "primary" as const,
                run: async () => {
                  try {
                    await store.regenerateSessionTitle(sessionId);
                    return { sessionId };
                  } catch (error: unknown) {
                    reportError(error, "重新生成标题失败");
                    throw error;
                  }
                }
              }]
            : []),
          {
            id: "switch-mode",
            label: "切换模式",
            variant: "primary" as const,
            run: async ({ values }: { values: Record<string, unknown> }) => {
              const modeId = String(values.modeId ?? "");
              if (!modeSupportsSession(session, modeId)) {
                const error = new Error("当前会话类型不支持此模式");
                reportError(error, error.message);
                throw error;
              }
              try {
                await store.switchSessionMode(sessionId, modeId);
                return { sessionId, modeId };
              } catch (error: unknown) {
                reportError(error, "切换模式失败");
                throw error;
              }
            }
          },
          {
            id: "delete",
            label: "删除会话",
            variant: "danger" as const,
            run: async ({ windowId }: { windowId: string }) => {
              const confirmResult = await windows.open({
                kind: "child-dialog",
                parentId: windowId,
                title: "确认删除会话",
                description: "删除后将立即移除当前会话，且无法恢复。",
                size: "sm",
                modal: true,
                context: createSessionWindowContext(sessionId),
                blocks: [
                  {
                    kind: "text" as const,
                    content: `将删除会话「${session.displayLabel || session.id}」。此操作不可恢复。`
                  }
                ],
                actions: [
                  {
                    id: "confirm-delete",
                    label: "确认删除",
                    variant: "danger",
                    run: async () => {
                      try {
                        await store.deleteSession(sessionId);
                        return { sessionId };
                      } catch (error: unknown) {
                        reportError(error, "删除会话失败");
                        throw error;
                      }
                    }
                  }
                ]
              });

              if (confirmResult.reason !== "action" || confirmResult.actionId !== "confirm-delete") {
                throw CANCEL_WINDOW_ACTION;
              }

              windows.closeByContext(createSessionWindowContext(sessionId), {
                reason: "dismiss",
                values: {}
              });
              throw CANCEL_WINDOW_ACTION;
            }
          }
        ]
      });
    }

    return {
      store,
      loading,
      mobileHeaderTitle,
      initializeSection,
      resetState,
      selectSession,
      refreshSessions,
      openCreateDialog,
      openSessionActions
    };
});

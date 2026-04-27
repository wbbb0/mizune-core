import { computed, ref, type ComputedRef, type Ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { authApi, type AuthSettings } from "@/api/auth";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";

type SettingsSectionState = {
  auth: ReturnType<typeof useAuthStore>;
  activeItem: Ref<"auth" | "logout" | null>;
  settings: Ref<AuthSettings | null>;
  loadingSettings: Ref<boolean>;
  savingPassword: Ref<boolean>;
  passkeyBusy: Ref<boolean>;
  loggingOut: Ref<boolean>;
  passwordError: Ref<string>;
  passwordSuccess: Ref<string>;
  passkeyError: Ref<string>;
  passkeySuccess: Ref<string>;
  currentPassword: Ref<string>;
  newPassword: Ref<string>;
  confirmPassword: Ref<string>;
  passkeyLabel: Ref<string>;
  supportsPasskey: ComputedRef<boolean>;
  initializeSection: () => Promise<void>;
  resetState: () => void;
  selectItem: (item: "auth" | "logout") => void;
  refreshSettings: () => Promise<void>;
  submitPasswordChange: () => Promise<void>;
  registerPasskey: () => Promise<void>;
  removePasskey: () => Promise<void>;
  logout: () => Promise<void>;
  formatTime: (value: number | null | undefined) => string;
};

export const useSettingsSection = createSharedSectionState<SettingsSectionState>(() => {
    const router = useRouter();
    const auth = useAuthStore();
    const runtime = useWorkbenchRuntime();
    const activeItem = ref<"auth" | "logout" | null>(null);
    const settings = ref<AuthSettings | null>(null);
    const loadingSettings = ref(false);
    const savingPassword = ref(false);
    const passkeyBusy = ref(false);
    const loggingOut = ref(false);
    const passwordError = ref("");
    const passwordSuccess = ref("");
    const passkeyError = ref("");
    const passkeySuccess = ref("");
    const currentPassword = ref("");
    const newPassword = ref("");
    const confirmPassword = ref("");
    const passkeyLabel = ref("当前设备");
    const initialized = ref(false);
    const supportsPasskey = computed(() => typeof window !== "undefined" && "PublicKeyCredential" in window);
    let stateVersion = 0;

    function isStale(requestVersion: number) {
      return requestVersion !== stateVersion;
    }

    function resetState() {
      stateVersion += 1;
      initialized.value = false;
      activeItem.value = null;
      settings.value = null;
      loadingSettings.value = false;
      savingPassword.value = false;
      passkeyBusy.value = false;
      loggingOut.value = false;
      passwordError.value = "";
      passwordSuccess.value = "";
      passkeyError.value = "";
      passkeySuccess.value = "";
      currentPassword.value = "";
      newPassword.value = "";
      confirmPassword.value = "";
      passkeyLabel.value = "当前设备";
    }

    async function refreshSettings() {
      const requestVersion = stateVersion;
      loadingSettings.value = true;
      try {
        const nextSettings = await authApi.settings();
        if (isStale(requestVersion)) {
          return;
        }
        settings.value = nextSettings;
      } finally {
        if (!isStale(requestVersion)) {
          loadingSettings.value = false;
        }
      }
    }

    async function initializeSection() {
      if (initialized.value) {
        return;
      }

      initialized.value = true;
      activeItem.value = null;

      if (!auth.enabled) {
        settings.value = null;
        return;
      }

      await refreshSettings();
    }

    function selectItem(item: "auth" | "logout") {
      activeItem.value = item;
      runtime.showMain();
    }

    async function submitPasswordChange() {
      const requestVersion = stateVersion;
      if (savingPassword.value) return;
      passwordError.value = "";
      passwordSuccess.value = "";
      if (!currentPassword.value || !newPassword.value) {
        passwordError.value = "请完整填写当前密码和新密码";
        return;
      }
      if (newPassword.value !== confirmPassword.value) {
        passwordError.value = "两次输入的新密码不一致";
        return;
      }

      savingPassword.value = true;
      try {
        await auth.changePassword(currentPassword.value, newPassword.value);
        if (isStale(requestVersion)) {
          return;
        }
        passwordSuccess.value = "密码已更新，需要重新登录";
        currentPassword.value = "";
        newPassword.value = "";
        confirmPassword.value = "";
        await router.push("/login");
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        passwordError.value = error instanceof Error ? error.message : "修改密码失败";
      } finally {
        if (!isStale(requestVersion)) {
          savingPassword.value = false;
        }
      }
    }

    async function registerPasskey() {
      const requestVersion = stateVersion;
      if (!supportsPasskey.value || passkeyBusy.value) return;
      passkeyBusy.value = true;
      passkeyError.value = "";
      passkeySuccess.value = "";
      try {
        await auth.registerPasskey(passkeyLabel.value.trim() || "当前设备");
        if (isStale(requestVersion)) {
          return;
        }
        passkeySuccess.value = settings.value?.passkey ? "Passkey 已重新注册" : "Passkey 已注册";
        await refreshSettings();
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        passkeyError.value = error instanceof Error ? error.message : "Passkey 注册失败";
      } finally {
        if (!isStale(requestVersion)) {
          passkeyBusy.value = false;
        }
      }
    }

    async function removePasskey() {
      const requestVersion = stateVersion;
      if (passkeyBusy.value) return;
      passkeyBusy.value = true;
      passkeyError.value = "";
      passkeySuccess.value = "";
      try {
        await auth.deletePasskey();
        if (isStale(requestVersion)) {
          return;
        }
        passkeySuccess.value = "Passkey 已删除";
        await refreshSettings();
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        passkeyError.value = error instanceof Error ? error.message : "删除 Passkey 失败";
      } finally {
        if (!isStale(requestVersion)) {
          passkeyBusy.value = false;
        }
      }
    }

    async function logout() {
      const requestVersion = stateVersion;
      loggingOut.value = true;
      try {
        await auth.logout();
        if (isStale(requestVersion)) {
          return;
        }
        await router.push("/login");
      } finally {
        if (!isStale(requestVersion)) {
          loggingOut.value = false;
        }
      }
    }

    function formatTime(value: number | null | undefined): string {
      if (!value) return "未使用";
      return new Date(value).toLocaleString("zh-CN");
    }

    return {
      auth,
      activeItem,
      settings,
      loadingSettings,
      savingPassword,
      passkeyBusy,
      loggingOut,
      passwordError,
      passwordSuccess,
      passkeyError,
      passkeySuccess,
      currentPassword,
      newPassword,
      confirmPassword,
      passkeyLabel,
      supportsPasskey,
      initializeSection,
      resetState,
      selectItem,
      refreshSettings,
      submitPasswordChange,
      registerPasskey,
      removePasskey,
      logout,
      formatTime
    };
});

export type { AuthSettings };

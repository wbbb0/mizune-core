import { defineStore } from "pinia";
import { ref } from "vue";
import { authApi } from "@/api/auth";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export const useAuthStore = defineStore("auth", () => {
  const enabled = ref(true);
  const authenticated = ref(false);
  const checked = ref(false);
  const ownerId = ref<string | null>(null);

  function applyStatus(status: { enabled: boolean; authenticated: boolean }): void {
    enabled.value = status.enabled;
    authenticated.value = enabled.value ? status.authenticated : true;
  }

  async function fetchOwnerId(): Promise<void> {
    try {
      const res = await authApi.configSummary();
      ownerId.value = res.access.ownerId ?? null;
    } catch {
      // non-fatal: ownerId stays null
    }
  }

  async function check(): Promise<void> {
    try {
      const res = await authApi.me();
      applyStatus(res);
      if (authenticated.value || !enabled.value) {
        await fetchOwnerId();
      } else {
        ownerId.value = null;
      }
    } catch {
      enabled.value = true;
      authenticated.value = false;
      ownerId.value = null;
    } finally {
      checked.value = true;
    }
  }

  async function login(password: string): Promise<void> {
    await authApi.login(password);
    enabled.value = true;
    authenticated.value = true;
    checked.value = true;
    await fetchOwnerId();
  }

  async function loginWithPasskey(): Promise<void> {
    const options = await authApi.beginPasskeyLogin();
    const response = await startAuthentication({ optionsJSON: options });
    await authApi.finishPasskeyLogin(response);
    enabled.value = true;
    authenticated.value = true;
    checked.value = true;
    await fetchOwnerId();
  }

  async function registerPasskey(label: string): Promise<void> {
    const options = await authApi.beginPasskeyRegistration();
    const response = await startRegistration({ optionsJSON: options });
    await authApi.finishPasskeyRegistration(response, label);
  }

  async function deletePasskey(): Promise<void> {
    await authApi.deletePasskey();
  }

  async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await authApi.changePassword(currentPassword, newPassword);
    if (enabled.value) {
      authenticated.value = false;
      ownerId.value = null;
    }
  }

  function markUnauthorized(): void {
    if (!enabled.value) {
      return;
    }
    authenticated.value = false;
    checked.value = true;
    ownerId.value = null;
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout();
    } finally {
      if (enabled.value) {
        authenticated.value = false;
        ownerId.value = null;
      }
    }
  }

  return {
    enabled,
    authenticated,
    checked,
    ownerId,
    check,
    login,
    loginWithPasskey,
    registerPasskey,
    deletePasskey,
    changePassword,
    markUnauthorized,
    logout
  };
});

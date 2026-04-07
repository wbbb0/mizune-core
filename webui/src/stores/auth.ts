import { defineStore } from "pinia";
import { ref } from "vue";
import { authApi } from "@/api/auth";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export const useAuthStore = defineStore("auth", () => {
  const authenticated = ref(false);
  const checked = ref(false);
  const ownerQq = ref<string | null>(null);

  async function fetchOwnerQq(): Promise<void> {
    try {
      const res = await authApi.whitelist();
      ownerQq.value = res.whitelist.ownerQq ?? null;
    } catch {
      // non-fatal: ownerQq stays null
    }
  }

  async function check(): Promise<void> {
    try {
      const res = await authApi.me();
      authenticated.value = res.authenticated;
      if (res.authenticated) await fetchOwnerQq();
    } catch {
      authenticated.value = false;
    } finally {
      checked.value = true;
    }
  }

  async function login(password: string): Promise<void> {
    await authApi.login(password);
    authenticated.value = true;
    checked.value = true;
    await fetchOwnerQq();
  }

  async function loginWithPasskey(): Promise<void> {
    const options = await authApi.beginPasskeyLogin();
    const response = await startAuthentication({ optionsJSON: options });
    await authApi.finishPasskeyLogin(response);
    authenticated.value = true;
    checked.value = true;
    await fetchOwnerQq();
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
    authenticated.value = false;
    ownerQq.value = null;
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout();
    } finally {
      authenticated.value = false;
      ownerQq.value = null;
    }
  }

  return {
    authenticated,
    checked,
    ownerQq,
    check,
    login,
    loginWithPasskey,
    registerPasskey,
    deletePasskey,
    changePassword,
    logout
  };
});

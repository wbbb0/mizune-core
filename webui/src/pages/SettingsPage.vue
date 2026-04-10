<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { KeyRound, LockKeyhole, LogOut, Trash2 } from "lucide-vue-next";
import AppLayout from "@/components/layout/AppLayout.vue";
import { useAuthStore } from "@/stores/auth";
import { authApi, type AuthSettings } from "@/api/auth";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();
const router = useRouter();
const auth = useAuthStore();
const layout = ref<InstanceType<typeof AppLayout> | null>(null);
const activeItem = ref<"auth" | "logout">("auth");
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
const supportsPasskey = computed(() => typeof window !== "undefined" && "PublicKeyCredential" in window);

onMounted(() => {
  void refreshSettings();
});

function selectItem(item: "auth" | "logout") {
  activeItem.value = item;
  layout.value?.openDetail();
}

async function refreshSettings() {
  loadingSettings.value = true;
  try {
    settings.value = await authApi.settings();
  } finally {
    loadingSettings.value = false;
  }
}

async function submitPasswordChange() {
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
    passwordSuccess.value = "密码已更新，需要重新登录";
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    await router.push("/login");
  } catch (error: unknown) {
    passwordError.value = error instanceof Error ? error.message : "修改密码失败";
  } finally {
    savingPassword.value = false;
  }
}

async function registerPasskey() {
  if (!supportsPasskey.value || passkeyBusy.value) return;
  passkeyBusy.value = true;
  passkeyError.value = "";
  passkeySuccess.value = "";
  try {
    await auth.registerPasskey(passkeyLabel.value.trim() || "当前设备");
    passkeySuccess.value = settings.value?.passkey ? "Passkey 已重新注册" : "Passkey 已注册";
    await refreshSettings();
  } catch (error: unknown) {
    passkeyError.value = error instanceof Error ? error.message : "Passkey 注册失败";
  } finally {
    passkeyBusy.value = false;
  }
}

async function removePasskey() {
  if (passkeyBusy.value) return;
  passkeyBusy.value = true;
  passkeyError.value = "";
  passkeySuccess.value = "";
  try {
    await auth.deletePasskey();
    passkeySuccess.value = "Passkey 已删除";
    await refreshSettings();
  } catch (error: unknown) {
    passkeyError.value = error instanceof Error ? error.message : "删除 Passkey 失败";
  } finally {
    passkeyBusy.value = false;
  }
}

async function logout() {
  loggingOut.value = true;
  try {
    await auth.logout();
    router.push("/login");
  } finally {
    loggingOut.value = false;
  }
}

function formatTime(value: number | null | undefined): string {
  if (!value) return "未使用";
  return new Date(value).toLocaleString("zh-CN");
}
</script>

<template>
  <AppLayout ref="layout">
    <template #side>
      <div v-if="!ui.isMobile" class="panel-header flex h-10 shrink-0 items-center border-b px-3">
        <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">设置</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <button class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left" :class="{ 'is-selected': activeItem === 'auth' }" @click="selectItem('auth')">
          <span class="text-ui text-text-secondary">认证</span>
          <LockKeyhole :size="14" :stroke-width="1.75" class="text-text-subtle" />
        </button>
        <button class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left" :class="{ 'is-selected': activeItem === 'logout' }" @click="selectItem('logout')">
          <span class="text-ui text-text-secondary">退出登录</span>
          <LogOut :size="14" :stroke-width="1.75" class="text-text-subtle" />
        </button>
      </div>
    </template>

    <template #main>
      <div class="flex h-full flex-col overflow-hidden">
        <header class="toolbar-header flex h-10 shrink-0 items-center gap-2.5 border-b px-4">
          <span class="text-ui font-medium text-text-secondary">{{ activeItem === "auth" ? "认证设置" : "退出登录" }}</span>
        </header>

        <div v-if="activeItem === 'auth'" class="scrollbar-thin flex-1 overflow-y-auto p-4">
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div v-if="loadingSettings" class="text-small text-text-muted">加载中…</div>

            <section class="rounded-xl border border-border-default bg-surface-panel p-4">
              <div class="mb-4 flex items-start gap-3">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-text-secondary">
                  <LockKeyhole :size="18" :stroke-width="1.75" />
                </div>
                <div>
                  <h2 class="text-ui font-medium text-text-primary">修改密码</h2>
                  <p class="mt-1 text-small text-text-muted">修改后所有已登录会话都会失效，需要重新登录。</p>
                </div>
              </div>

              <form class="grid gap-3 md:grid-cols-2" @submit.prevent="submitPasswordChange">
                <label class="flex flex-col gap-1 text-small text-text-muted">
                  当前密码
                  <input v-model="currentPassword" type="password" autocomplete="current-password" class="input-base text-ui" />
                </label>
                <div />
                <label class="flex flex-col gap-1 text-small text-text-muted">
                  新密码
                  <input v-model="newPassword" type="password" autocomplete="new-password" class="input-base text-ui" />
                </label>
                <label class="flex flex-col gap-1 text-small text-text-muted">
                  确认新密码
                  <input v-model="confirmPassword" type="password" autocomplete="new-password" class="input-base text-ui" />
                </label>
                <p v-if="passwordError" class="m-0 text-small text-danger md:col-span-2">{{ passwordError }}</p>
                <p v-if="passwordSuccess" class="m-0 text-small text-success md:col-span-2">{{ passwordSuccess }}</p>
                <div class="md:col-span-2 flex justify-end">
                  <button class="btn btn-primary" type="submit" :disabled="savingPassword">
                    {{ savingPassword ? "保存中…" : "更新密码" }}
                  </button>
                </div>
              </form>
            </section>

            <section class="rounded-xl border border-border-default bg-surface-panel p-4">
              <div class="mb-4 flex items-start gap-3">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-text-secondary">
                  <KeyRound :size="18" :stroke-width="1.75" />
                </div>
                <div>
                  <h2 class="text-ui font-medium text-text-primary">Passkey</h2>
                  <p class="mt-1 text-small text-text-muted">只保留一个 Passkey。重新注册会直接覆盖当前凭证。</p>
                </div>
              </div>

              <div v-if="!supportsPasskey" class="text-small text-text-muted">当前环境不支持 Passkey。</div>
              <template v-else>
                <div class="mb-4 rounded-lg border border-border-default bg-surface-muted px-3 py-2 text-small text-text-muted">
                  <div>当前状态：{{ settings?.passkey ? "已注册" : "未注册" }}</div>
                  <div v-if="settings?.passkey">标签：{{ settings.passkey.label }}</div>
                  <div v-if="settings?.passkey">创建时间：{{ formatTime(settings.passkey.createdAt) }}</div>
                  <div v-if="settings?.passkey">最近使用：{{ formatTime(settings.passkey.lastUsedAt) }}</div>
                </div>

                <div class="flex flex-col gap-3 md:flex-row md:items-end">
                  <label class="flex flex-1 flex-col gap-1 text-small text-text-muted">
                    设备标签
                    <input v-model="passkeyLabel" type="text" class="input-base text-ui" />
                  </label>
                  <div class="flex gap-2">
                    <button class="btn btn-primary" type="button" :disabled="passkeyBusy" @click="registerPasskey">
                      {{ passkeyBusy ? "处理中…" : settings?.passkey ? "重新注册 Passkey" : "注册 Passkey" }}
                    </button>
                    <button v-if="settings?.passkey" class="btn btn-secondary" type="button" :disabled="passkeyBusy" @click="removePasskey">
                      <Trash2 :size="14" :stroke-width="1.75" />
                      删除
                    </button>
                  </div>
                </div>
                <p v-if="passkeyError" class="m-0 mt-3 text-small text-danger">{{ passkeyError }}</p>
                <p v-if="passkeySuccess" class="m-0 mt-3 text-small text-success">{{ passkeySuccess }}</p>
              </template>
            </section>
          </div>
        </div>

        <div v-else class="flex flex-1 items-center justify-center p-4">
          <div class="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border-default bg-surface-panel p-4">
            <div class="flex items-start gap-3">
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-text-secondary">
                <LogOut :size="18" :stroke-width="1.75" />
              </div>
              <div class="min-w-0 flex-1">
                <h2 class="text-ui font-medium text-text-primary">退出登录</h2>
                <p class="mt-1 text-small text-text-muted">退出当前 WebUI 会话，返回登录页。</p>
              </div>
            </div>
            <div class="flex justify-end">
              <button class="btn btn-primary" :disabled="loggingOut" @click="logout">
                {{ loggingOut ? "退出中…" : "退出登录" }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AppLayout>
</template>

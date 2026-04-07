<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { KeyRound } from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";
import { ApiError } from "@/api/client";

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const username = "admin";
const password = ref("");
const loading = ref(false);
const passkeyLoading = ref(false);
const error = ref("");
const supportsPasskey = computed(() => typeof window !== "undefined" && "PublicKeyCredential" in window);

async function submit() {
  if (!password.value.trim() || loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    await auth.login(password.value);
    const redirect = String(route.query.redirect ?? "/sessions");
    router.replace(redirect);
  } catch (e) {
    error.value = e instanceof ApiError && e.status === 401
      ? "密码不正确，请重试"
      : "登录失败，请稍后重试";
  } finally {
    loading.value = false;
  }
}

async function loginWithPasskey() {
  if (passkeyLoading.value) return;
  passkeyLoading.value = true;
  error.value = "";
  try {
    await auth.loginWithPasskey();
    const redirect = String(route.query.redirect ?? "/sessions");
    router.replace(redirect);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Passkey 登录失败";
  } finally {
    passkeyLoading.value = false;
  }
}
</script>

<template>
  <div class="flex h-full items-center justify-center bg-surface-app px-6 pb-safe-offset-6">
    <div class="w-full max-w-96 rounded border border-border-default bg-surface-sidebar px-7 py-8">
      <h1 class="m-0 mb-1 text-[18px] font-semibold text-text-secondary">llm-bot</h1>
      <p class="m-0 mb-6 text-small text-text-muted">WebUI 管理界面</p>

      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <label class="sr-only" for="username">用户名</label>
        <input
          id="username"
          :value="username"
          type="text"
          autocomplete="username webauthn"
          readonly
          tabindex="-1"
          class="sr-only"
        />

        <label class="text-small tracking-[0.05em] text-text-muted uppercase" for="password">密码</label>
        <input
          id="password"
          v-model="password"
          name="password"
          type="password"
          class="input-base text-ui"
          placeholder="输入 WebUI 密码"
          autocomplete="current-password"
          autofocus
          :disabled="loading || passkeyLoading"
        />

        <p v-if="error" class="m-0 text-small text-danger">{{ error }}</p>

        <button type="submit" class="btn btn-primary mt-1 h-8 justify-center" :disabled="loading || passkeyLoading || !password.trim()">
          {{ loading ? "登录中…" : "使用密码登录" }}
        </button>

        <button
          v-if="supportsPasskey"
          type="button"
          class="btn btn-secondary h-8 justify-center"
          :disabled="loading || passkeyLoading"
          @click="loginWithPasskey"
        >
          <KeyRound :size="14" :stroke-width="1.8" />
          {{ passkeyLoading ? "验证中…" : "使用 Passkey 登录" }}
        </button>
        <p v-else class="m-0 text-small text-text-muted">当前环境不支持 Passkey，请使用密码登录。</p>
      </form>
    </div>
  </div>
</template>

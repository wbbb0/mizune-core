<script setup lang="ts">
import { KeyRound, LockKeyhole, LogOut, Trash2 } from "lucide-vue-next";
import { useSettingsSection } from "@/composables/sections/useSettingsSection";
import {
  WorkbenchAreaHeader,
  WorkbenchCard,
  WorkbenchCardStack,
  WorkbenchEmptyState,
  WorkbenchFeatureCard
} from "@workbench-kit/vue";

const {
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
  submitPasswordChange,
  registerPasskey,
  removePasskey,
  logout,
  formatTime
} = useSettingsSection();
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <WorkbenchEmptyState v-if="!activeItem" message="← 选择一个设置项" />

    <template v-else>
      <WorkbenchAreaHeader class="gap-2.5 px-4" :uppercase="false">
        <span class="text-ui font-medium text-text-secondary">{{ activeItem === "auth" ? "认证设置" : "退出登录" }}</span>
      </WorkbenchAreaHeader>

      <div v-if="activeItem === 'auth'" class="scrollbar-thin flex-1 overflow-y-auto p-4">
        <WorkbenchCardStack max-width="3xl">
          <WorkbenchFeatureCard v-if="!auth.enabled" title="认证已关闭" :icon="LockKeyhole">
            <p class="m-0 text-small text-text-muted">当前实例在配置中关闭了 WebUI 认证，页面访问不再要求登录。若需恢复登录保护，请在配置中重新开启认证。</p>
          </WorkbenchFeatureCard>

          <div v-else-if="loadingSettings" class="text-small text-text-muted">加载中…</div>

          <WorkbenchFeatureCard
            v-if="auth.enabled"
            title="修改密码"
            subtitle="修改后所有已登录会话都会失效，需要重新登录。"
            :icon="LockKeyhole"
          >
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
          </WorkbenchFeatureCard>

          <WorkbenchFeatureCard
            v-if="auth.enabled"
            title="Passkey"
            subtitle="只保留一个 Passkey。重新注册会直接覆盖当前凭证。"
            :icon="KeyRound"
          >
            <div v-if="!supportsPasskey" class="text-small text-text-muted">当前环境不支持 Passkey。</div>
            <template v-else>
              <WorkbenchCard class="mb-4 text-small text-text-muted" surface="muted">
                <div>当前状态：{{ settings?.passkey ? "已注册" : "未注册" }}</div>
                <div v-if="settings?.passkey">标签：{{ settings.passkey.label }}</div>
                <div v-if="settings?.passkey">创建时间：{{ formatTime(settings.passkey.createdAt) }}</div>
                <div v-if="settings?.passkey">最近使用：{{ formatTime(settings.passkey.lastUsedAt) }}</div>
              </WorkbenchCard>

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
          </WorkbenchFeatureCard>
        </WorkbenchCardStack>
      </div>

      <div v-else-if="auth.enabled" class="flex flex-1 items-center justify-center p-4">
        <WorkbenchFeatureCard class="w-full max-w-md" title="退出登录" subtitle="退出当前 WebUI 会话，返回登录页。" :icon="LogOut">
          <div class="flex justify-end">
            <button class="btn btn-primary" :disabled="loggingOut" @click="logout">
              {{ loggingOut ? "退出中…" : "退出登录" }}
            </button>
          </div>
        </WorkbenchFeatureCard>
      </div>

      <WorkbenchEmptyState v-else message="当前实例未启用认证" />
    </template>
  </div>
</template>

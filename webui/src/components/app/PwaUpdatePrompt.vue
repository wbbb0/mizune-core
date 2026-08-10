<script setup lang="ts">
import { RefreshCw, X } from "lucide-vue-next";
import { usePwaUpdate } from "@/composables/usePwaUpdate";

const { updateAvailable, updating, applyUpdate, dismissUpdate } = usePwaUpdate();
</script>

<template>
  <Transition
    enter-active-class="transition duration-150 ease-out"
    enter-from-class="translate-y-2 opacity-0"
    leave-active-class="transition duration-100 ease-in"
    leave-to-class="translate-y-2 opacity-0"
  >
    <aside
      v-if="updateAvailable"
      class="fixed right-3 bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] z-[3100] w-[min(24rem,calc(100vw-1.5rem))] rounded-xl border border-border-default bg-surface-panel p-4 text-text-secondary shadow-xl"
      role="status"
      aria-live="polite"
      aria-label="WebUI 更新提示"
    >
      <div class="flex items-start gap-3">
        <RefreshCw :size="18" :stroke-width="2" class="mt-0.5 shrink-0 text-text-accent" />
        <div class="min-w-0 flex-1">
          <div class="text-ui font-medium text-text-primary">WebUI 新版本已就绪</div>
          <p class="mt-1 text-small leading-5 text-text-muted">刷新后即可使用最新版本，当前页面不会自动中断。</p>
        </div>
        <button
          type="button"
          class="btn-ghost -mt-1 -mr-1 shrink-0 p-1.5 text-text-muted hover:text-text-primary"
          title="关闭更新提示"
          aria-label="关闭更新提示"
          :disabled="updating"
          @click="dismissUpdate"
        >
          <X :size="16" :stroke-width="2" />
        </button>
      </div>
      <div class="mt-3 flex justify-end">
        <button type="button" class="btn btn-primary h-8 gap-1.5" :disabled="updating" @click="applyUpdate">
          <RefreshCw :size="14" :stroke-width="2" :class="{ spin: updating }" />
          {{ updating ? "正在刷新…" : "立即刷新" }}
        </button>
      </div>
    </aside>
  </Transition>
</template>

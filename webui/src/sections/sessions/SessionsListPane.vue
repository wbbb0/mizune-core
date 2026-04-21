<script setup lang="ts">
import { onMounted } from "vue";
import { Plus, RefreshCw } from "lucide-vue-next";
import WorkbenchDialog from "@/components/common/WorkbenchDialog.vue";
import SessionListItem from "@/components/sessions/SessionListItem.vue";
import CreateSessionDialog from "@/components/sessions/CreateSessionDialog.vue";
import { useSessionsSection } from "@/composables/sections/useSessionsSection";

const section = useSessionsSection();

onMounted(() => {
  void section.initializeSection();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="panel-header flex h-10 shrink-0 items-center justify-between border-b px-3">
      <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">会话</span>
      <div class="flex items-center gap-1">
        <button class="btn-ghost" title="新建 Web 会话" @click="section.openCreateDialog">
          <Plus :size="14" :stroke-width="2" />
        </button>
        <button class="btn-ghost" :disabled="section.loading" title="刷新" @click="section.refreshSessions">
          <RefreshCw :size="14" :class="{ spin: section.loading }" :stroke-width="2" />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="section.store.list.length === 0 && !section.loading" class="px-3 py-6 text-center text-small text-text-subtle">
        暂无活跃会话
      </div>
      <SessionListItem
        v-for="session in section.store.list"
        :key="session.id"
        :session="session"
        :selected="section.store.selectedId === session.id"
        @select="section.selectSession(session.id)"
        @open-actions="section.openSessionActions"
      />
    </div>

    <CreateSessionDialog
      :open="section.createDialogOpen"
      :busy="section.createDialogBusy"
      :error-message="section.createDialogError"
      :modes="section.store.modes"
      @close="section.closeCreateDialog"
      @submit="section.submitCreateSession"
    />

    <WorkbenchDialog
      :open="Boolean(section.actionsDialogSessionId)"
      title="会话操作"
      description="管理标题、切换当前会话模式，或删除该会话。"
      variant="content"
      width-class="max-w-lg"
      body-class="px-4 py-4"
      @close="section.closeSessionActions"
    >
      <div class="flex flex-col gap-4">
        <div
          v-if="section.actionsDialogError"
          class="rounded border border-[color:color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
        >
          {{ section.actionsDialogError }}
        </div>

        <div v-if="section.actionsDialogSupportsTitleEditing" class="flex flex-col gap-2">
          <div class="text-small font-medium text-text-secondary">标题</div>
          <div class="rounded-lg border border-border-default bg-surface-sidebar p-3">
            <input
              v-model="section.actionsDialogTitleDraft"
              class="input-base w-full text-ui"
              :disabled="section.actionsDialogBusy"
              placeholder="输入会话标题"
            />
            <div class="mt-2 text-small text-text-subtle">{{ section.actionsDialogTitleSourceLabel }}</div>
            <div v-if="section.actionsDialogDetail && !section.actionsDialogTitleGenerationAvailable" class="mt-1 text-small text-text-subtle">
              标题生成器不可用
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button class="btn btn-secondary" type="button" :disabled="section.actionsDialogBusy" @click="section.saveSessionTitle">
                {{ section.actionsDialogBusy ? "处理中…" : "保存标题" }}
              </button>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="section.actionsDialogBusy || !section.actionsDialogTitleGenerationAvailable"
                @click="section.regenerateSessionTitle"
              >
                {{ section.actionsDialogBusy ? "处理中…" : "重新生成标题" }}
              </button>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <div class="text-small font-medium text-text-secondary">切换模式</div>
          <div class="flex flex-col gap-2">
            <button
              v-for="mode in section.store.modes"
              :key="mode.id"
              class="flex items-start justify-between rounded-lg border border-border-default bg-surface-sidebar px-3 py-2 text-left hover:bg-surface-active disabled:opacity-60"
              :disabled="section.actionsDialogBusy || !section.actionsDialogSessionId || !section.modeSupportsCurrentSession(mode.id)"
              @click="section.actionsDialogSessionId && section.switchSessionMode(section.actionsDialogSessionId, mode.id)"
            >
              <div class="min-w-0 flex-1">
                <div class="text-ui font-medium text-text-secondary">{{ mode.title }}</div>
                <div class="mt-1 text-small text-text-muted">{{ mode.description }}</div>
                <div v-if="!section.modeSupportsCurrentSession(mode.id)" class="mt-1 text-small text-text-subtle">
                  当前会话类型不支持此模式
                </div>
              </div>
              <span v-if="section.actionsSession?.modeId === mode.id" class="ml-3 shrink-0 text-small text-text-subtle">
                当前
              </span>
            </button>
          </div>
        </div>

        <div class="border-t border-border-subtle pt-4">
          <button
            class="flex w-full items-center justify-center rounded-lg border border-[color:color-mix(in_srgb,var(--danger)_45%,transparent)] bg-surface-danger px-3 py-2 text-ui font-medium text-danger disabled:opacity-60"
            :disabled="section.actionsDialogBusy || !section.actionsDialogSessionId"
            @click="section.actionsDialogSessionId && section.deleteSession(section.actionsDialogSessionId)"
          >
            删除会话
          </button>
        </div>
      </div>

      <template #footer>
        <button class="btn btn-secondary" :disabled="section.actionsDialogBusy" @click="section.closeSessionActions">
          关闭
        </button>
      </template>
    </WorkbenchDialog>
  </div>
</template>

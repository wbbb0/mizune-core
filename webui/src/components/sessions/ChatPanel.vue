<script setup lang="ts">
import { ref, computed, reactive, provide, watch } from "vue";
import { Wifi, WifiOff, Loader, RefreshCw } from "lucide-vue-next";
import MessageBubble from "./MessageBubble.vue";
import TranscriptItem from "./TranscriptItem.vue";
import VirtualMessageList from "./VirtualMessageList.vue";
import Composer from "./Composer.vue";
import SessionStatePanel from "./SessionStatePanel.vue";
import { openImagePreviewWindow } from "@/components/common/imagePreviewWindow";
import { useSessionsStore } from "@/stores/sessions";
import { useAuthStore } from "@/stores/auth";
import { ApiError } from "@/api/client";
import type { TranscriptEntry } from "@/stores/sessions";
import type { TranscriptItem as SessionTranscriptItem } from "@/api/types";
import { useWorkbenchToasts } from "@/components/workbench/toasts/useWorkbenchToasts";
import { useWorkbenchWindows } from "@/composables/workbench/useWorkbenchWindows";
import { buildChatTimelineItems } from "./chatTimeline";
import type { ChatTimelineItem } from "./chatTimeline";
import { resolveComposerUserIdentity } from "./composerUserIdentity";

const store = useSessionsStore();
const auth  = useAuthStore();
const toast = useWorkbenchToasts();
const windows = useWorkbenchWindows();
const session = computed(() => store.active);

// Transcript item expand state — keyed by item.id, survives virtual scroll mount/unmount cycles
export interface TranscriptExpandState {
  expanded: boolean;
  reasoningExpanded: boolean;
  plannerExpanded: boolean;
}
const transcriptExpandStates = reactive(new Map<string, TranscriptExpandState>());
provide("transcriptExpandStates", transcriptExpandStates);
watch(() => session.value?.id, () => { transcriptExpandStates.clear(); });

// Tabs
type Tab = "chat" | "transcript" | "state";
const tab = ref<Tab>("chat");

interface TranscriptActionTarget {
  itemId: string;
  groupId: string;
  title: string;
  detail: string;
  alreadyInvalidated: boolean;
}

const reversedMessages = computed(() =>
  session.value
    ? buildChatTimelineItems(session.value.transcript, {
      activeComposerUserId: session.value.composerUserId?.trim() ?? null,
      draftAssistantText: session.value.draftAssistantText,
      draftTurnId: session.value.draftTurnId
    })
    : []
);
const reversedTranscript = computed(() =>
  session.value ? [...session.value.transcript].reverse() : []
);

const statusColor = computed(() => {
  if (!session.value) return "";
  if (session.value.streamStatus === "connected") return "green";
  if (session.value.streamStatus === "error")     return "red";
  return "yellow";
});

const isPrivate = computed(() => session.value?.type === "private");

const composerIdentity = computed(() => resolveComposerUserIdentity({
  session: session.value
    ? {
        type: session.value.type,
        source: session.value.source,
        participantRef: session.value.participantRef
      }
    : null,
  ownerId: auth.ownerId
}));

const lockedUserId = computed(() => composerIdentity.value.lockedUserId);
const defaultUserId = computed(() => composerIdentity.value.defaultUserId);

async function onSend(
  payload: { userId: string; text: string; imageIds: string[]; attachmentIds: string[] },
  callbacks: { resolve: () => void; reject: (error: unknown) => void }
) {
  try {
    await store.sendMessage(payload);
    callbacks.resolve();
  } catch (error) {
    callbacks.reject(error);
  }
}

function onComposerUserIdChange(userId: string) {
  store.setComposerUserId(userId || null);
}

function previewImage(src: string, title: string) {
  void openImagePreviewWindow(windows, { src, title });
}

function openTranscriptActions(target: TranscriptActionTarget) {
  void windows.open({
    kind: "dialog",
    title: "消息操作",
    description: `${target.title} · ${target.detail}`,
    size: "md",
    blocks: [
      {
        kind: "text",
        content: `目标：${target.detail}`
      }
    ],
    actions: [
      {
        id: "invalidate-single",
        label: "删除单条",
        variant: "secondary",
        run: async () => {
          if (target.alreadyInvalidated) {
            const error = new Error("当前记录已失效，无需重复删除。");
            toast.push({ type: "error", message: error.message });
            throw error;
          }
          try {
            await store.excludeTranscriptItem(target.itemId);
            return { target: target.itemId };
          } catch (error: unknown) {
            const message = error instanceof ApiError || error instanceof Error
              ? error.message
              : "删除失败";
            toast.push({ type: "error", message });
            throw error;
          }
        }
      },
      {
        id: "invalidate-group",
        label: "删除整组",
        variant: "danger",
        run: async () => {
          if (target.alreadyInvalidated) {
            const error = new Error("当前记录所在分组已失效，无需重复删除。");
            toast.push({ type: "error", message: error.message });
            throw error;
          }
          try {
            await store.excludeTranscriptGroup(target.groupId);
            return { target: target.groupId };
          } catch (error: unknown) {
            const message = error instanceof ApiError || error instanceof Error
              ? error.message
              : "删除失败";
            toast.push({ type: "error", message });
            throw error;
          }
        }
      }
    ]
  });
}

function buildChatActionTarget(item: ChatTimelineItem): TranscriptActionTarget | null {
  if (item.kind === "text" && item.actionsEnabled === false) {
    return null;
  }
  return {
    itemId: item.itemId,
    groupId: item.groupId,
    title: item.actionTitle,
    detail: item.kind === "text"
      ? (item.label || item.content.slice(0, 32) || "消息")
      : (item.sourceName || item.fileRef || item.fileId || "图片"),
    alreadyInvalidated: false
  };
}

function openChatItemActions(item: ChatTimelineItem): void {
  const target = buildChatActionTarget(item);
  if (!target) {
    return;
  }
  openTranscriptActions(target);
}

function buildTranscriptActionTarget(entry: TranscriptEntry): TranscriptActionTarget {
  return {
    itemId: entry.item.id,
    groupId: entry.item.groupId,
    title: describeTranscriptItem(entry.item),
    detail: `#${entry.index}`,
    alreadyInvalidated: entry.item.runtimeExcluded === true
  };
}

function describeTranscriptItem(item: SessionTranscriptItem): string {
  switch (item.kind) {
    case "user_message":
      return "用户消息";
    case "assistant_message":
      return "模型回复";
    case "outbound_media_message":
      return "发送图片";
    case "direct_command":
      return item.direction === "input" ? "指令输入" : "指令输出";
    case "assistant_tool_call":
      return "工具调用";
    case "tool_result":
      return "工具结果";
    case "session_mode_switch":
      return "模式切换";
    case "status_message":
      return "状态消息";
    case "gate_decision":
      return "Turn Planner 判定";
    case "title_generation_event":
      return "标题生成";
    case "system_marker":
      return "系统标记";
    case "fallback_event":
      return "兜底事件";
    case "internal_trigger_event":
      return "内部触发事件";
  }
}

</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <!-- Header -->
    <header v-if="session" class="toolbar-header flex h-10 shrink-0 items-center justify-between gap-3 border-b px-4">
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="flex items-center"
          :class="{
            'text-success': statusColor === 'green',
            'text-danger': statusColor === 'red',
            'text-warning': statusColor === 'yellow'
          }"
          :title="session.streamStatus"
        >
          <Wifi v-if="session.streamStatus === 'connected'" :size="12" :stroke-width="2" />
          <WifiOff v-else-if="session.streamStatus === 'error'" :size="12" :stroke-width="2" />
          <Loader v-else :size="12" :stroke-width="2" class="spin" />
        </span>
        <span
          class="badge-pill bg-surface-muted text-text-muted"
          :class="{
            'text-success': ['tool_calling', 'generating', 'delivering', 'requesting_llm', 'turn_planner_evaluating'].includes(session.phase.kind),
            'text-warning': ['turn_planner_waiting', 'debouncing'].includes(session.phase.kind)
          }"
        >{{ session.phase.label }}</span>
      </div>

      <!-- Tabs -->
      <div class="flex shrink-0">
        <button class="flex h-10 items-center gap-1 border-0 border-b-2 border-transparent bg-transparent px-3 text-small whitespace-nowrap text-text-muted transition-colors hover:text-text-primary" :class="{ 'border-b-accent text-text-secondary': tab === 'chat' }" @click="tab = 'chat'">聊天</button>
        <button class="flex h-10 items-center gap-1 border-0 border-b-2 border-transparent bg-transparent px-3 text-small whitespace-nowrap text-text-muted transition-colors hover:text-text-primary" :class="{ 'border-b-accent text-text-secondary': tab === 'transcript' }" @click="tab = 'transcript'">后台</button>
        <button class="flex h-10 items-center gap-1 border-0 border-b-2 border-transparent bg-transparent px-3 text-small whitespace-nowrap text-text-muted transition-colors hover:text-text-primary" :class="{ 'border-b-accent text-text-secondary': tab === 'state' }" @click="tab = 'state'">
          状态
        </button>
      </div>
    </header>

    <!-- No session selected -->
    <div v-if="!session" class="panel-empty flex flex-1 items-center justify-center">
      <span>← 选择一个会话</span>
    </div>

    <template v-else>
      <!-- Chat view: newest on top -->
      <div v-show="tab === 'chat'" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="sticky-toolbar flex shrink-0 items-center justify-between border-b px-3 py-1">
          <span class="text-small text-text-subtle">{{ session.transcriptCount }} 条消息</span>
          <button
            class="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
            title="从头重新拉取所有记录"
            @click="store.reloadTranscript()"
          >
            <RefreshCw :size="12" :stroke-width="2" />
            重新加载
          </button>
        </div>
        <div v-if="reversedMessages.length === 0" class="flex-1 px-6 py-6 text-center text-small text-text-subtle">
          暂无消息
        </div>
        <VirtualMessageList
          v-else
          class="min-h-0 flex-1"
          :items="reversedMessages"
          :has-more="session.transcriptHasMore"
          :loading-more="session.transcriptLoadingMore"
          @load-more="store.loadMoreTranscript()"
        >
          <template #item="{ item: msg }">
            <MessageBubble
              :side="msg.side"
              :role="msg.role"
              :kind="msg.kind"
              :content="msg.kind === 'text' ? msg.content : undefined"
              :label="msg.kind === 'text' ? msg.label : undefined"
              :sender-label="msg.kind === 'text' ? msg.senderLabel : undefined"
              :meta-chips="msg.kind === 'text' ? msg.metaChips : undefined"
              :source-name="msg.kind === 'image' ? msg.sourceName : undefined"
              :file-ref="msg.kind === 'image' ? msg.fileRef : undefined"
              :file-id="msg.kind === 'image' ? msg.fileId : undefined"
              :image-url="msg.kind === 'image' ? msg.imageUrl : undefined"
              :tool-name="msg.kind === 'image' ? msg.toolName : undefined"
              :timestamp-ms="msg.timestampMs"
              :streaming="msg.kind === 'text' ? msg.streaming : undefined"
              :actions-enabled="msg.kind === 'text' ? msg.actionsEnabled : undefined"
              @preview-image="msg.kind === 'image' ? previewImage(msg.imageUrl, msg.sourceName || msg.fileRef || msg.fileId || '已发送图片') : undefined"
              @open-actions="openChatItemActions(msg)"
            />
          </template>
        </VirtualMessageList>
      </div>

      <!-- Transcript view: newest on top -->
      <div v-show="tab === 'transcript'" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="sticky-toolbar flex shrink-0 items-center justify-between border-b px-3 py-1">
          <span class="text-small text-text-subtle">{{ session.transcriptCount }} 条记录</span>
          <button
            class="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
            title="从头重新拉取所有记录"
            @click="store.reloadTranscript()"
          >
            <RefreshCw :size="12" :stroke-width="2" />
            重新加载
          </button>
        </div>
        <div v-if="reversedTranscript.length === 0" class="flex-1 px-6 py-6 text-center text-small text-text-subtle">暂无记录</div>
        <VirtualMessageList
          v-else
          class="min-h-0 flex-1"
          :items="reversedTranscript"
          :has-more="session.transcriptHasMore"
          :loading-more="session.transcriptLoadingMore"
          @load-more="store.loadMoreTranscript()"
        >
          <template #item="{ item: entry }">
            <TranscriptItem
              :item="entry.item"
              :index="entry.index"
              @open-actions="openTranscriptActions(buildTranscriptActionTarget(entry))"
            />
          </template>
        </VirtualMessageList>
      </div>

      <SessionStatePanel v-show="tab === 'state'" :session="session" />

      <!-- Composer -->
      <Composer
        v-if="tab !== 'state'"
        :session-type="isPrivate ? 'private' : 'group'"
        :locked-user-id="lockedUserId"
        :default-user-id="defaultUserId"
        :disabled="session.streamStatus !== 'connected'"
        @user-id-change="onComposerUserIdChange"
        @send="onSend"
      />
    </template>
  </div>

</template>

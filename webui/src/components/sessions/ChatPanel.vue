<script setup lang="ts">
import { ref, computed, reactive, provide, watch } from "vue";
import { Wifi, WifiOff, Loader, RefreshCw, Trash2 } from "lucide-vue-next";
import MessageBubble from "./MessageBubble.vue";
import TranscriptItem from "./TranscriptItem.vue";
import VirtualMessageList from "./VirtualMessageList.vue";
import Composer from "./Composer.vue";
import SessionStatePanel from "./SessionStatePanel.vue";
import ImagePreviewDialog from "@/components/common/ImagePreviewDialog.vue";
import { useSessionsStore } from "@/stores/sessions";
import { useAuthStore } from "@/stores/auth";
import { ApiError } from "@/api/client";
import type { TranscriptItem as SessionTranscriptItem } from "@/api/types";
import { fileApi } from "@/api/workspace";

const store = useSessionsStore();
const auth  = useAuthStore();
const session = computed(() => store.active);

// Transcript item expand state — keyed by eventId, survives virtual scroll mount/unmount cycles
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

type ChatTimelineItem =
  | {
      eventId: string;
      kind: "text";
      role: "user" | "assistant";
      side: "left" | "right";
      content: string;
      senderLabel?: string;
      metaChips?: string[];
      timestampMs: number;
      label?: string;
    }
  | {
      eventId: string;
      kind: "image";
      role: "assistant";
      side: "left" | "right";
      sourceName: string | null;
      fileRef: string | null;
      fileId: string | null;
      imageUrl: string;
      toolName: string;
      timestampMs: number;
    };

const previewImage = ref<{ src: string; title: string } | null>(null);

function toChatTimelineItem(entry: { eventId: string; item: SessionTranscriptItem }): ChatTimelineItem | null {
  if (entry.item.kind === "user_message" || entry.item.kind === "assistant_message") {
    const side = resolveMessageSide(entry.item);
    return {
      eventId: entry.eventId,
      kind: "text",
      role: entry.item.role,
      side,
      content: entry.item.text,
      senderLabel: formatSenderLabel(entry.item),
      metaChips: buildMetaChips(entry.item),
      timestampMs: entry.item.timestampMs
    };
  }

  if (entry.item.kind === "direct_command") {
    return {
      eventId: entry.eventId,
      kind: "text",
      role: entry.item.role,
      side: entry.item.role === "user" ? "right" : "left",
      content: entry.item.content,
      timestampMs: entry.item.timestampMs,
      label: entry.item.direction === "input"
        ? `指令输入 · ${entry.item.commandName}`
        : `指令输出 · ${entry.item.commandName}`
    };
  }

  if (entry.item.kind === "outbound_media_message") {
    const imageUrl = entry.item.fileId
      ? fileApi.getChatFileContentUrlById(entry.item.fileId)
      : (entry.item.sourcePath ? fileApi.getLocalSendFileContentUrl(entry.item.sourcePath) : "");
    if (!imageUrl) {
      return null;
    }
    return {
      eventId: entry.eventId,
      kind: "image",
      role: "assistant",
      side: "left",
      sourceName: entry.item.sourceName,
      fileRef: entry.item.fileRef,
      fileId: entry.item.fileId,
      imageUrl,
      toolName: entry.item.toolName,
      timestampMs: entry.item.timestampMs
    };
  }

  return null;
}

function formatSenderLabel(item: Extract<SessionTranscriptItem, { kind: "user_message" | "assistant_message" }>): string | undefined {
  if (item.chatType === "private" && item.kind === "assistant_message") {
    return undefined;
  }
  const name = item.senderName.trim();
  const userId = item.userId.trim();
  if (!name) {
    return userId || undefined;
  }
  if (!userId || userId === name) {
    return name;
  }
  return `${name} · ${userId}`;
}

function buildMetaChips(item: Extract<SessionTranscriptItem, { kind: "user_message" | "assistant_message" }>): string[] {
  if (item.kind !== "user_message") {
    return [];
  }
  const chips: string[] = [];
  if (item.replyMessageId) chips.push("回复");
  if (item.mentionedSelf) chips.push("@我");
  if (item.mentionedAll) chips.push("@全体");
  if (item.imageIds.length > 0) chips.push(`图片 ${item.imageIds.length}`);
  if (item.emojiIds.length > 0) chips.push(`表情 ${item.emojiIds.length}`);
  if (item.audioCount > 0) chips.push(`语音 ${item.audioCount}`);
  if (item.forwardIds.length > 0) chips.push(`转发 ${item.forwardIds.length}`);
  return chips;
}

function resolveMessageSide(item: Extract<SessionTranscriptItem, { kind: "user_message" | "assistant_message" }>): "left" | "right" {
  if (item.chatType === "private") {
    return item.role === "user" ? "right" : "left";
  }
  if (item.role !== "user") {
    return "left";
  }
  const selectedUserId = store.active?.composerUserId?.trim();
  return selectedUserId && item.userId === selectedUserId ? "right" : "left";
}

const reversedMessages = computed(() =>
  session.value
    ? session.value.transcript
      .map((entry) => toChatTimelineItem(entry))
      .filter((item): item is ChatTimelineItem => item != null)
      .reverse()
    : []
);
const reversedTranscript = computed(() =>
  session.value ? [...session.value.transcript].reverse() : []
);

// Session header info
const headerLabel = computed(() => {
  if (!session.value) return "";
  return session.value.participantLabel || session.value.participantUserId || session.value.id;
});

const statusColor = computed(() => {
  if (!session.value) return "";
  if (session.value.streamStatus === "connected") return "green";
  if (session.value.streamStatus === "error")     return "red";
  return "yellow";
});

// Composer userId logic
const isPrivate = computed(() => session.value?.type === "private");

// OneBot private sessions use a fixed remote user ID.
const lockedUserId = computed(() => {
  if (!session.value || !isPrivate.value || session.value.source !== "onebot") return undefined;
  return session.value.participantUserId;
});

// Web sessions default to the participant identity; OneBot group sessions use the owner identity.
const defaultUserId = computed(() =>
  session.value?.source === "web"
    ? session.value.participantUserId
    : !isPrivate.value
      ? (auth.ownerId ?? undefined)
      : undefined
);

async function onSend(payload: { userId: string; text: string; imageIds: string[] }) {
  try {
    await store.sendMessage(payload);
  } catch (error) {
    const message = error instanceof ApiError || error instanceof Error
      ? error.message
      : "发送失败";
    window.alert(message);
  }
}

function onComposerUserIdChange(userId: string) {
  store.setComposerUserId(userId || null);
}

async function onDeleteSession() {
  if (!session.value) {
    return;
  }
  if (!window.confirm(`删除会话 ${headerLabel.value}？`)) {
    return;
  }
  await store.deleteSelectedSession();
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
        <button
          v-if="session.source === 'web'"
          class="flex h-10 items-center gap-1 border-0 bg-transparent px-2 text-small whitespace-nowrap text-text-muted transition-colors hover:text-danger"
          @click="onDeleteSession"
        >
          <Trash2 :size="14" :stroke-width="1.75" />
        </button>
        <button class="flex h-10 items-center gap-1 border-0 border-b-2 border-transparent bg-transparent px-3 text-small whitespace-nowrap text-text-muted transition-colors hover:text-text-primary" :class="{ 'border-b-accent text-text-secondary': tab === 'chat' }" @click="tab = 'chat'">聊天</button>
        <button class="flex h-10 items-center gap-1 border-0 border-b-2 border-transparent bg-transparent px-3 text-small whitespace-nowrap text-text-muted transition-colors hover:text-text-primary" :class="{ 'border-b-accent text-text-secondary': tab === 'transcript' }" @click="tab = 'transcript'">
          后台记录
          <span v-if="session?.transcriptCount" class="rounded-full bg-surface-muted px-1 text-[10px] text-text-muted">{{ session.transcriptCount }}</span>
        </button>
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
              @preview-image="msg.kind === 'image' ? previewImage = { src: msg.imageUrl, title: msg.sourceName || msg.fileRef || msg.fileId || '已发送图片' } : undefined"
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
              :event-id="entry.eventId"
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

  <ImagePreviewDialog
    :open="previewImage !== null"
    :src="previewImage?.src || ''"
    :title="previewImage?.title"
    @close="previewImage = null"
  />
</template>

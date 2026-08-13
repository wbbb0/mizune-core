<script setup lang="ts">
import { computed } from "vue";
import type { MinecraftActorJournalEvent } from "@/api/minecraftActors";

const props = defineProps<{ events: MinecraftActorJournalEvent[] }>();
const sorted = computed(() => [...props.events].sort((left, right) => right.eventId - left.eventId));

function eventTitle(event: MinecraftActorJournalEvent) {
  return ({
    owner_request_queued: "收到主人委派",
    wake_queued: "事件进入唤醒队列",
    decision_started: "开始模型决策",
    decision_completed: "决策完成",
    decision_retry_scheduled: "决策失败，等待重试",
    decision_interrupted: "决策被打断",
    decision_dead_letter: "决策多次失败",
    decision_recovered: "恢复未完成决策",
    actor_closed: "资源已关闭"
  } as Record<string, string>)[event.eventType] ?? event.eventType;
}

function payloadSummary(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  for (const key of ["summary", "instruction", "error", "reason"]) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return "";
}
</script>

<template>
  <div class="space-y-2">
    <article v-for="event in sorted" :key="event.eventId" class="rounded-lg border border-border-subtle bg-surface-raised px-4 py-3">
      <div class="flex items-start gap-3">
        <span
          class="mt-1 h-2 w-2 shrink-0 rounded-full"
          :class="event.severity === 'critical' ? 'bg-danger' : event.severity === 'warning' ? 'bg-warning' : 'bg-accent'"
        />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <span class="font-medium text-text">{{ eventTitle(event) }}</span>
            <time class="text-caption text-text-subtle">{{ new Date(event.occurredAtMs).toLocaleString() }}</time>
          </div>
          <p v-if="payloadSummary(event.payload)" class="mt-1 whitespace-pre-wrap text-small text-text-muted">{{ payloadSummary(event.payload) }}</p>
          <div class="mt-1 text-caption text-text-subtle">#{{ event.eventId }} · revision {{ event.actorRevision }}</div>
        </div>
      </div>
    </article>
    <div v-if="events.length === 0" class="py-10 text-center text-small text-text-subtle">暂无 Actor 动态</div>
  </div>
</template>

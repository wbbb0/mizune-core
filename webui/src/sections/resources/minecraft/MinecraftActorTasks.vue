<script setup lang="ts">
import type { MinecraftActorRequest } from "@/api/minecraftActors";

defineProps<{ requests: MinecraftActorRequest[] }>();

function statusLabel(status: MinecraftActorRequest["status"]) {
  return ({ queued: "排队", running: "执行中", completed: "完成", failed: "失败", interrupted: "已打断", cancelled: "已取消" })[status];
}
</script>

<template>
  <div class="space-y-2">
    <article v-for="request in requests" :key="request.requestId" class="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-medium text-text">{{ request.instruction }}</div>
          <div v-if="request.constraints" class="mt-1 text-small text-text-muted">约束：{{ request.constraints }}</div>
        </div>
        <span class="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-caption text-text-muted">{{ statusLabel(request.status) }}</span>
      </div>
      <p v-if="request.resultSummary" class="mt-3 text-small text-text-muted">{{ request.resultSummary }}</p>
      <p v-if="request.error" class="mt-3 text-small text-danger">{{ request.error }}</p>
      <div class="mt-2 text-caption text-text-subtle">{{ request.priority === "high" ? "高优先级" : "普通优先级" }} · {{ new Date(request.createdAtMs).toLocaleString() }}</div>
    </article>
    <div v-if="requests.length === 0" class="py-10 text-center text-small text-text-subtle">尚未委派任务</div>
  </div>
</template>

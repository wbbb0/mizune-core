<script setup lang="ts">
import type { MinecraftActorDetail } from "@/api/minecraftActors";

defineProps<{ actor: MinecraftActorDetail }>();
</script>

<template>
  <div class="grid gap-3 lg:grid-cols-2">
    <section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div class="font-medium text-text">自身</div>
      <pre class="mt-3 overflow-auto whitespace-pre-wrap text-small text-text-muted">{{ JSON.stringify(actor.runtimeSnapshot?.self ?? null, null, 2) }}</pre>
    </section>
    <section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div class="font-medium text-text">活动与队列</div>
      <pre class="mt-3 overflow-auto whitespace-pre-wrap text-small text-text-muted">{{ JSON.stringify({ activeTask: actor.runtimeSnapshot?.activeTask ?? null, activeBehavior: actor.runtimeSnapshot?.activeBehavior ?? null, queuedTaskCount: actor.runtimeSnapshot?.queuedTaskCount ?? 0 }, null, 2) }}</pre>
    </section>
    <div class="rounded-lg border border-border-subtle bg-surface-raised p-4 text-small text-text-muted lg:col-span-2">
      附近实体、背包和环境观察将在 NeoForge Bridge 提供对应结构化 observation 后显示；页面协议已经预留独立感知区域。
    </div>
  </div>
</template>

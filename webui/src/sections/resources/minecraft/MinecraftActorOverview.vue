<script setup lang="ts">
import type { MinecraftActorDetail } from "@/api/minecraftActors";

defineProps<{ actor: MinecraftActorDetail }>();

function coordinates(actor: MinecraftActorDetail) {
  const position = actor.runtimeSnapshot?.self.position;
  return position ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : "未知";
}
</script>

<template>
  <div class="grid gap-3 lg:grid-cols-2">
    <section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div class="text-caption text-text-subtle">当前目标</div>
      <div class="mt-1 text-base font-medium text-text">{{ actor.currentGoal || "暂无明确目标" }}</div>
      <p class="mt-3 whitespace-pre-wrap text-small leading-6 text-text-muted">{{ actor.persistentState || "暂无持久认知摘要" }}</p>
    </section>

    <section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div class="text-caption text-text-subtle">身体状态</div>
      <div v-if="actor.runtimeSnapshot" class="mt-2 grid grid-cols-2 gap-3 text-small">
        <div><span class="text-text-subtle">位置</span><div class="mt-0.5 font-mono text-text">{{ coordinates(actor) }}</div></div>
        <div><span class="text-text-subtle">连接</span><div class="mt-0.5 text-text">{{ actor.runtimeSnapshot.self.connected ? "已连接" : "已断开" }}</div></div>
        <div><span class="text-text-subtle">生命</span><div class="mt-0.5 text-text">{{ actor.runtimeSnapshot.self.health }}</div></div>
        <div><span class="text-text-subtle">饥饿</span><div class="mt-0.5 text-text">{{ actor.runtimeSnapshot.self.food }} / 20</div></div>
      </div>
      <p v-else class="mt-2 text-small text-danger">{{ actor.runtimeError || "Runtime 状态不可用" }}</p>
    </section>

    <section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div class="text-caption text-text-subtle">当前执行</div>
      <div v-if="actor.runtimeSnapshot?.activeTask" class="mt-2">
        <div class="font-medium text-text">{{ actor.runtimeSnapshot.activeTask.kind }}</div>
        <div class="mt-1 text-small text-text-muted">{{ actor.runtimeSnapshot.activeTask.status }} · {{ actor.runtimeSnapshot.activeTask.priority }}</div>
      </div>
      <div v-else-if="actor.runtimeSnapshot?.activeBehavior" class="mt-2">
        <div class="font-medium text-text">{{ actor.runtimeSnapshot.activeBehavior.capability }}</div>
        <div class="mt-1 text-small text-text-muted">{{ actor.runtimeSnapshot.activeBehavior.status }}</div>
      </div>
      <p v-else class="mt-2 text-small text-text-subtle">当前没有底层行为</p>
    </section>

    <section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div class="text-caption text-text-subtle">自治策略</div>
      <div class="mt-2 text-small text-text">
        {{ actor.runtimeSnapshot?.autonomyPolicy.enabled ? "已开启" : "已关闭" }}
      </div>
      <div v-if="actor.runtimeSnapshot" class="mt-2 text-small leading-6 text-text-muted">
        探索半径 {{ actor.runtimeSnapshot.autonomyPolicy.exploreRadius }} ·
        战斗止损生命 {{ actor.runtimeSnapshot.autonomyPolicy.combatStopHealth }}
      </div>
    </section>
  </div>
</template>

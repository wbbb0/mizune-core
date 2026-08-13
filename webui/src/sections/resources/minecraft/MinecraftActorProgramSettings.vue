<script setup lang="ts">
import type { MinecraftActorDetail } from "@/api/minecraftActors";
defineProps<{ actor: MinecraftActorDetail }>();
</script>

<template>
  <div class="space-y-3">
    <section class="rounded-lg border border-warning/30 bg-warning/5 p-4">
      <div class="font-medium text-text">Python 行为执行尚未开放</div>
      <p class="mt-1 text-small leading-6 text-text-muted">
        当前只支持程序校验与版本化契约，不会在真实客户端执行模型生成的 Python。隔离 worker、资源预算和 host API 白名单完成后才会开放。
      </p>
    </section>
    <section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div class="font-medium text-text">能力状态</div>
      <dl class="mt-3 grid gap-2 text-small sm:grid-cols-2">
        <div><dt class="text-text-subtle">程序校验</dt><dd class="text-text">{{ actor.capabilities.programValidationSupported ? "允许" : "禁用" }}</dd></div>
        <div><dt class="text-text-subtle">程序执行</dt><dd class="text-text">未实现安全执行器</dd></div>
        <div><dt class="text-text-subtle">自治</dt><dd class="text-text">{{ actor.runtimeSnapshot?.autonomyPolicy.enabled ? "开启" : "关闭" }}</dd></div>
        <div><dt class="text-text-subtle">紧急停手</dt><dd class="text-text">等待独立安全 RPC</dd></div>
      </dl>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useResourceSelection } from "@/composables/sections/resourceSelection";
import ResourcesMainPane from "./ResourcesMainPane.vue";
import MinecraftActorWorkspace from "./minecraft/MinecraftActorWorkspace.vue";

const { selectedKind } = useResourceSelection();
const showActor = computed(() => selectedKind.value === "minecraft_actor");
</script>

<template>
  <MinecraftActorWorkspace v-if="showActor" />
  <ResourcesMainPane v-else />
</template>

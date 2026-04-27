<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth   = useAuthStore();

// React to 401 responses emitted by the API client
function onUnauthorized() {
  auth.markUnauthorized();
  if (!auth.enabled) {
    return;
  }
  router.push({ name: "login" });
}

onMounted(()   => window.addEventListener("api:unauthorized", onUnauthorized));
onUnmounted(() => window.removeEventListener("api:unauthorized", onUnauthorized));
</script>

<template>
  <RouterView />
</template>

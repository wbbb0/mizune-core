import { computed, ref } from "vue";
import { useActiveWorkbenchRuntime } from "@/components/workbench/runtime/workbenchRuntime";

const activeRuntime = useActiveWorkbenchRuntime();
const fallbackMobileScreen = ref<"list" | "main">("list");
const auxOpen = ref(false);
const mobileScreen = computed(() => {
  const runtime = activeRuntime.value;
  return runtime ? (runtime.isMobileMainVisible.value ? "main" : "list") : fallbackMobileScreen.value;
});

function showList() {
  const runtime = activeRuntime.value;
  if (runtime) {
    runtime.showList();
    return;
  }
  fallbackMobileScreen.value = "list";
}

function showMain(detailKey?: string) {
  const runtime = activeRuntime.value;
  if (runtime) {
    runtime.showMain(detailKey);
    return;
  }
  fallbackMobileScreen.value = "main";
}

function openAux() {
  auxOpen.value = true;
}

function closeAux() {
  auxOpen.value = false;
}

const sharedWorkbenchRuntime = {
  mobileScreen,
  auxOpen,
  showList,
  showMain,
  openAux,
  closeAux
};

export function useWorkbenchRuntime() {
  return sharedWorkbenchRuntime;
}

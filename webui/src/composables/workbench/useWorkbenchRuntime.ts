import { ref } from "vue";
import { useWorkbenchRuntimeContext } from "@/components/workbench/runtime/workbenchRuntime";

const mobileScreen = ref<"list" | "main">("list");
const auxOpen = ref(false);

function showList() {
  mobileScreen.value = "list";
}

function showMain() {
  mobileScreen.value = "main";
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
  const providedRuntime = useWorkbenchRuntimeContext();
  return providedRuntime ?? sharedWorkbenchRuntime;
}

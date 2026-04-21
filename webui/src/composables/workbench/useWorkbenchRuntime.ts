import { ref } from "vue";

const mobileScreen = ref<"list" | "main">("list");
const auxOpen = ref(false);
const topMenuOpen = ref(false);
const bottomMenuOpen = ref(false);

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

function toggleTopMenu() {
  topMenuOpen.value = !topMenuOpen.value;
}

function toggleBottomMenu() {
  bottomMenuOpen.value = !bottomMenuOpen.value;
}

const sharedWorkbenchRuntime = {
  mobileScreen,
  auxOpen,
  topMenuOpen,
  bottomMenuOpen,
  showList,
  showMain,
  openAux,
  closeAux,
  toggleTopMenu,
  toggleBottomMenu
};

export function useWorkbenchRuntime() {
  return sharedWorkbenchRuntime;
}

import { computed, ref } from "vue";

export type ResourceSelection =
  | { kind: "minecraft_actor"; id: string }
  | { kind: "shell_session"; id: string };

const selectedResource = ref<ResourceSelection | null>(null);

export function useResourceSelection() {
  return {
    selectedResource,
    selectedKind: computed(() => selectedResource.value?.kind ?? null),
    selectResource(selection: ResourceSelection) {
      selectedResource.value = selection;
    },
    clearResourceSelection() {
      selectedResource.value = null;
    }
  };
}

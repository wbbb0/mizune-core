import { shallowRef } from "vue";
import type { ResourceEditorClient } from "./types";

const activeResourceEditorClient = shallowRef<ResourceEditorClient | null>(null);

export function configureResourceEditorClient(client: ResourceEditorClient | null): void {
  activeResourceEditorClient.value = client;
}

export function useResourceEditorClient(): ResourceEditorClient | null {
  return activeResourceEditorClient.value;
}

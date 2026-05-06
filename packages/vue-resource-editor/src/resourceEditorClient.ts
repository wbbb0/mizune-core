import { shallowRef } from "vue";
import type { ResourceEditorClient } from "./types";

const activeResourceEditorClient = shallowRef<ResourceEditorClient | null>(null);

/** 注册当前应用的资源编辑 client。通常在 app 启动时调用一次。 */
export function configureResourceEditorClient(client: ResourceEditorClient | null): void {
  activeResourceEditorClient.value = client;
}

/** 获取当前注册的资源编辑 client。未注册时返回 null。 */
export function useResourceEditorClient(): ResourceEditorClient | null {
  return activeResourceEditorClient.value;
}

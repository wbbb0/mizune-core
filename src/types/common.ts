export type ChatType = "private" | "group";

export interface AppLifecycleHooks {
  shutdown: () => Promise<void>;
}

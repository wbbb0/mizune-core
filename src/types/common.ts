export type ChatType = "private" | "group";

export interface AppLifecycleHooks {
  services?: import("#app/bootstrap/appServiceBootstrap.ts").AppServiceBootstrap;
  shutdown: () => Promise<void>;
}

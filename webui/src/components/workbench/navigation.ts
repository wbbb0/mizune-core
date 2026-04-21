import type { Component } from "vue";
import { Database, Folder, MessageSquare, Settings, SlidersHorizontal } from "lucide-vue-next";

export type WorkbenchNavItem = {
  id: string;
  title: string;
  path: string;
  icon: Component;
  placement: "primary" | "bottom";
};

export const workbenchNavItems = [
  { id: "sessions", title: "会话", path: "/sessions", icon: MessageSquare, placement: "primary" },
  { id: "config", title: "配置", path: "/config", icon: SlidersHorizontal, placement: "primary" },
  { id: "data", title: "数据", path: "/data", icon: Database, placement: "primary" },
  { id: "files", title: "文件", path: "/files", icon: Folder, placement: "primary" },
  { id: "settings", title: "设置", path: "/settings", icon: Settings, placement: "bottom" }
] as const satisfies readonly WorkbenchNavItem[];

import { Database, Folder, MessageSquare, Settings, SlidersHorizontal } from "lucide-vue-next";
import type { WorkbenchNavItem } from "@/components/workbench/navigation";

export type AppWorkbenchNavItem = WorkbenchNavItem & {
  path: string;
};

export const workbenchNavItems = [
  { id: "sessions", title: "会话", path: "/sessions", icon: MessageSquare, placement: "primary" },
  { id: "config", title: "配置", path: "/config", icon: SlidersHorizontal, placement: "primary" },
  { id: "data", title: "数据", path: "/data", icon: Database, placement: "primary" },
  { id: "files", title: "文件", path: "/files", icon: Folder, placement: "primary" },
  { id: "settings", title: "设置", path: "/settings", icon: Settings, placement: "bottom" }
] as const satisfies readonly AppWorkbenchNavItem[];

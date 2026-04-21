import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { workbenchNavItems } from "@/components/workbench/navigation";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import AuthStatusChip from "@/components/workbench/status/AuthStatusChip.vue";
import { useUiStore } from "@/stores/ui";

export function useWorkbenchChrome() {
  const route = useRoute();
  const router = useRouter();
  const ui = useUiStore();

  const topbarMenus = computed<WorkbenchTopbarMenu[]>(() => [
    {
      id: "pages",
      label: "页面",
      resolveItems: () => workbenchNavItems.map((item) => ({
        kind: "radio" as const,
        id: `page-${item.id}`,
        label: item.title,
        checked: route.name === item.id,
        onSelect: () => {
          void router.push(item.path);
        }
      }))
    },
    {
      id: "display",
      label: "显示",
      resolveItems: () => [
        {
          kind: "radio" as const,
          id: "theme-system",
          label: "跟随系统",
          checked: ui.themeMode === "system",
          onSelect: () => ui.setThemeMode("system")
        },
        {
          kind: "radio" as const,
          id: "theme-light",
          label: "亮",
          checked: ui.themeMode === "light",
          onSelect: () => ui.setThemeMode("light")
        },
        {
          kind: "radio" as const,
          id: "theme-dark",
          label: "暗",
          checked: ui.themeMode === "dark",
          onSelect: () => ui.setThemeMode("dark")
        }
      ]
    }
  ]);

  const statusbarItems = computed<WorkbenchStatusbarItem[]>(() => [
    {
      id: "auth-status",
      component: AuthStatusChip
    }
  ]);

  return { topbarMenus, statusbarItems };
}

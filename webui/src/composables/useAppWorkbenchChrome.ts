import { computed, type ComputedRef } from "vue";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import type { WorkbenchNavItem } from "@/components/workbench/navigation";
import AuthStatusChip from "@/components/app/AuthStatusChip.vue";
import { useUiStore } from "@/stores/ui";

type AppWorkbenchChromeOptions = {
  navItems: readonly WorkbenchNavItem[];
  activeNavItemId: ComputedRef<string>;
  onNavigate: (itemId: string) => void;
};

export function useAppWorkbenchChrome(options: AppWorkbenchChromeOptions) {
  const ui = useUiStore();

  const topbarMenus = computed<WorkbenchTopbarMenu[]>(() => [
    {
      id: "pages",
      label: "页面",
      resolveItems: () => options.navItems.map((item) => ({
        kind: "radio" as const,
        id: `page-${item.id}`,
        label: item.title,
        checked: options.activeNavItemId.value === item.id,
        onSelect: () => {
          options.onNavigate(item.id);
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

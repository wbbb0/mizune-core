import { defineWorkbenchView, type WorkbenchView } from "@/components/workbench/types";
import { workbenchNavItems } from "@/sections/navigation";
import { sessionsView } from "@/sections/sessions";
import { configView } from "@/sections/config";
import { dataView } from "@/sections/data";
import { settingsView } from "@/sections/settings";
import { workspaceView } from "@/sections/workspace";
import { defineComponent, h } from "vue";

const placeholderPrimarySidebar = defineComponent({
  name: "WorkbenchPlaceholderPrimarySidebar",
  setup() {
    return () =>
      h("div", { class: "p-4 text-sm text-text-muted" }, "占位列表面板");
  }
});

const placeholderMainArea = defineComponent({
  name: "WorkbenchPlaceholderMainArea",
  setup() {
    return () =>
      h("div", { class: "p-4 text-sm text-text-muted" }, "占位主面板");
  }
});

function createPlaceholderView(id: string, title: string): WorkbenchView {
  return defineWorkbenchView({
    id,
    title,
    areas: {
      primarySidebar: placeholderPrimarySidebar,
      mainArea: placeholderMainArea
    }
  });
}

export const workbenchViews: readonly WorkbenchView[] = Object.freeze(
  workbenchNavItems.map(({ id, title }) => {
    if (id === "sessions") return sessionsView;
    if (id === "config") return configView;
    if (id === "data") return dataView;
    if (id === "files") return workspaceView;
    if (id === "settings") return settingsView;
    return createPlaceholderView(id, title);
  })
);

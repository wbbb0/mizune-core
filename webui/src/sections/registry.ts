import { defineWorkbenchSection, type WorkbenchSection } from "@/components/workbench/types";
import { workbenchNavItems } from "@/components/workbench/navigation";
import { sessionsSection } from "@/sections/sessions";
import { configSection } from "@/sections/config";
import { dataSection } from "@/sections/data";
import { settingsSection } from "@/sections/settings";
import { workspaceSection } from "@/sections/workspace";
import { defineComponent, h } from "vue";

const placeholderListPane = defineComponent({
  name: "WorkbenchPlaceholderListPane",
  setup() {
    return () =>
      h("div", { class: "p-4 text-sm text-text-muted" }, "占位列表面板");
  }
});

const placeholderMainPane = defineComponent({
  name: "WorkbenchPlaceholderMainPane",
  setup() {
    return () =>
      h("div", { class: "p-4 text-sm text-text-muted" }, "占位主面板");
  }
});

function createPlaceholderSection(id: string, title: string): WorkbenchSection {
  return defineWorkbenchSection({
    id,
    title,
    regions: {
      listPane: placeholderListPane,
      mainPane: placeholderMainPane
    }
  });
}

export const workbenchSections: readonly WorkbenchSection[] = Object.freeze(
  workbenchNavItems.map(({ id, title }) => {
    if (id === "sessions") return sessionsSection;
    if (id === "config") return configSection;
    if (id === "data") return dataSection;
    if (id === "files") return workspaceSection;
    if (id === "settings") return settingsSection;
    return createPlaceholderSection(id, title);
  })
);

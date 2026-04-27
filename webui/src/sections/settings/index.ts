import type { WorkbenchSection } from "@/components/workbench/types";
import SettingsListPane from "./SettingsListPane.vue";
import SettingsMainPane from "./SettingsMainPane.vue";
import SettingsMobileHeader from "./SettingsMobileHeader.vue";

export const settingsSection = {
  id: "settings",
  title: "设置",
  regions: {
    listPane: SettingsListPane,
    mainPane: SettingsMainPane,
    mobileHeader: SettingsMobileHeader
  },
  layout: {
    mobile: {
      mainFlow: "list-main"
    },
    desktop: {
      listPane: {}
    }
  }
} satisfies WorkbenchSection;

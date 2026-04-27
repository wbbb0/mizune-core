import { defineWorkbenchSection } from "@/components/workbench/types";
import SettingsListPane from "./SettingsListPane.vue";
import SettingsMainPane from "./SettingsMainPane.vue";
import SettingsMobileHeader from "./SettingsMobileHeader.vue";

export const settingsSection = defineWorkbenchSection({
  id: "settings",
  title: "设置",
  regions: {
    listPane: SettingsListPane,
    mainPane: SettingsMainPane,
    mobileHeader: SettingsMobileHeader
  }
});

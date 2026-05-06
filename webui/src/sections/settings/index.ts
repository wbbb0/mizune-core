import { defineWorkbenchView } from "@llm-onebot/vue-workbench";
import SettingsListPane from "./SettingsListPane.vue";
import SettingsMainPane from "./SettingsMainPane.vue";
import SettingsMobileHeader from "./SettingsMobileHeader.vue";

export const settingsView = defineWorkbenchView({
  id: "settings",
  title: "设置",
  areas: {
    primarySidebar: SettingsListPane,
    mainArea: SettingsMainPane,
    mobileHeader: SettingsMobileHeader
  }
});

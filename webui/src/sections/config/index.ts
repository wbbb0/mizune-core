import { defineWorkbenchView } from "@workbench-kit/vue";
import ConfigListPane from "./ConfigListPane.vue";
import ConfigMainPane from "./ConfigMainPane.vue";

export const configView = defineWorkbenchView({
  id: "config",
  title: "配置",
  areas: {
    primarySidebar: ConfigListPane,
    mainArea: ConfigMainPane
  }
});

import { defineWorkbenchView } from "@/components/workbench/types";
import ConfigListPane from "./ConfigListPane.vue";
import ConfigMainPane from "./ConfigMainPane.vue";
import ConfigMobileHeader from "./ConfigMobileHeader.vue";

export const configView = defineWorkbenchView({
  id: "config",
  title: "配置",
  areas: {
    primarySidebar: ConfigListPane,
    mainArea: ConfigMainPane,
    mobileHeader: ConfigMobileHeader
  }
});

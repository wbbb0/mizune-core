import { defineWorkbenchSection } from "@/components/workbench/types";
import ConfigListPane from "./ConfigListPane.vue";
import ConfigMainPane from "./ConfigMainPane.vue";
import ConfigMobileHeader from "./ConfigMobileHeader.vue";

export const configSection = defineWorkbenchSection({
  id: "config",
  title: "配置",
  regions: {
    listPane: ConfigListPane,
    mainPane: ConfigMainPane,
    mobileHeader: ConfigMobileHeader
  }
});

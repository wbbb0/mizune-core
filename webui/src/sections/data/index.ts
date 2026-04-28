import { defineWorkbenchView } from "@/components/workbench/types";
import DataListPane from "./DataListPane.vue";
import DataMainPane from "./DataMainPane.vue";
import DataMobileHeader from "./DataMobileHeader.vue";

export const dataView = defineWorkbenchView({
  id: "data",
  title: "数据",
  areas: {
    primarySidebar: DataListPane,
    mainArea: DataMainPane,
    mobileHeader: DataMobileHeader
  }
});

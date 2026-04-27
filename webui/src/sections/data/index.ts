import type { WorkbenchSection } from "@/components/workbench/types";
import DataListPane from "./DataListPane.vue";
import DataMainPane from "./DataMainPane.vue";
import DataMobileHeader from "./DataMobileHeader.vue";

export const dataSection = {
  id: "data",
  title: "数据",
  regions: {
    listPane: DataListPane,
    mainPane: DataMainPane,
    mobileHeader: DataMobileHeader
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

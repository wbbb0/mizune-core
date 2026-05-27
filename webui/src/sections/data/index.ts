import { defineWorkbenchView } from "@workbench-kit/vue";
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
  },
  layout: {
    desktop: {
      primarySidebar: { defaultSizePx: 260, minSizePx: 220, maxSizePx: 420 },
      secondarySidebar: { defaultSizePx: 460, minSizePx: 320, maxSizePx: 720 }
    }
  }
});

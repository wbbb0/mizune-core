import { defineWorkbenchView } from "@workbench-kit/vue-workbench";
import ResourcesListPane from "./ResourcesListPane.vue";
import ResourcesMainPane from "./ResourcesMainPane.vue";
import ResourcesMobileHeader from "./ResourcesMobileHeader.vue";

export const resourcesView = defineWorkbenchView({
  id: "resources",
  title: "资源",
  areas: {
    primarySidebar: ResourcesListPane,
    mainArea: ResourcesMainPane,
    mobileHeader: ResourcesMobileHeader
  }
});

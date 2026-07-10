import { defineWorkbenchView } from "@workbench-kit/vue";
import ResourcesListPane from "./ResourcesListPane.vue";
import ResourcesMainPane from "./ResourcesMainPane.vue";

export const resourcesView = defineWorkbenchView({
  id: "resources",
  title: "资源",
  areas: {
    primarySidebar: ResourcesListPane,
    mainArea: ResourcesMainPane
  }
});

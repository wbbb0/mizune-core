import { defineWorkbenchView } from "@workbench-kit/vue";
import ResourcesListPane from "./ResourcesListPane.vue";
import ResourcesWorkspacePane from "./ResourcesWorkspacePane.vue";

export const resourcesView = defineWorkbenchView({
  id: "resources",
  title: "资源",
  areas: {
    primarySidebar: ResourcesListPane,
    mainArea: ResourcesWorkspacePane
  }
});

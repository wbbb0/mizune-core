import { defineWorkbenchSection } from "@/components/workbench/types";
import WorkspaceListPane from "./WorkspaceListPane.vue";
import WorkspaceMainPane from "./WorkspaceMainPane.vue";
import WorkspaceMobileHeader from "./WorkspaceMobileHeader.vue";

export const workspaceSection = defineWorkbenchSection({
  id: "files",
  title: "文件",
  regions: {
    listPane: WorkspaceListPane,
    mainPane: WorkspaceMainPane,
    mobileHeader: WorkspaceMobileHeader
  }
});

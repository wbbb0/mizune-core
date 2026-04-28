import { defineWorkbenchView } from "@/components/workbench/types";
import WorkspaceListPane from "./WorkspaceListPane.vue";
import WorkspaceMainPane from "./WorkspaceMainPane.vue";
import WorkspaceMobileHeader from "./WorkspaceMobileHeader.vue";

export const workspaceView = defineWorkbenchView({
  id: "files",
  title: "文件",
  areas: {
    primarySidebar: WorkspaceListPane,
    mainArea: WorkspaceMainPane,
    mobileHeader: WorkspaceMobileHeader
  }
});

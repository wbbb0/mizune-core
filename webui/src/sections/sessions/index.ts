import { defineWorkbenchView } from "@workbench-kit/vue";
import SessionsListPane from "./SessionsListPane.vue";
import SessionsMainPane from "./SessionsMainPane.vue";

export const sessionsView = defineWorkbenchView({
  id: "sessions",
  title: "会话",
  areas: {
    primarySidebar: SessionsListPane,
    mainArea: SessionsMainPane
  }
});

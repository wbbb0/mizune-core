import { defineWorkbenchView } from "@/components/workbench/types";
import SessionsListPane from "./SessionsListPane.vue";
import SessionsMainPane from "./SessionsMainPane.vue";
import SessionsMobileHeader from "./SessionsMobileHeader.vue";

export const sessionsView = defineWorkbenchView({
  id: "sessions",
  title: "会话",
  areas: {
    primarySidebar: SessionsListPane,
    mainArea: SessionsMainPane,
    mobileHeader: SessionsMobileHeader
  }
});

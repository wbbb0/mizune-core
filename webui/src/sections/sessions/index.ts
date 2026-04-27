import type { WorkbenchSection } from "@/components/workbench/types";
import SessionsListPane from "./SessionsListPane.vue";
import SessionsMainPane from "./SessionsMainPane.vue";
import SessionsMobileHeader from "./SessionsMobileHeader.vue";

export const sessionsSection = {
  id: "sessions",
  title: "会话",
  regions: {
    listPane: SessionsListPane,
    mainPane: SessionsMainPane,
    mobileHeader: SessionsMobileHeader
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

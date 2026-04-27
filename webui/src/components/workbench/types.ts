import type { Component } from "vue";

export type WorkbenchSection = {
  id: string;
  title: string;
  regions: {
    listPane?: Component;
    mainPane: Component;
    auxPane?: Component;
    topbar?: Component;
    statusbar?: Component;
    mobileHeader?: Component;
    mobileTopMenu?: Component;
    mobileBottomMenu?: Component;
  };
  layout: {
    mobile: {
      mainFlow: "list-main" | "main-only";
    };
    desktop: {
      listPane?: {
        defaultWidthPx?: number;
        minWidthPx?: number;
        maxWidthPx?: number;
      };
    };
  };
};

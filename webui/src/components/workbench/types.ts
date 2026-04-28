import type { Component } from "vue";

export type WorkbenchAreaId = "primarySidebar" | "mainArea" | "secondarySidebar" | "bottomPanel";

export type WorkbenchAreaSize = {
  defaultWidthPx?: number;
  minWidthPx?: number;
  maxWidthPx?: number;
};

export type WorkbenchViewLayout = {
  mobile: {
    rootArea: WorkbenchAreaId;
  };
  desktop: {
    primarySidebar?: WorkbenchAreaSize;
    secondarySidebar?: WorkbenchAreaSize;
    bottomPanel?: WorkbenchAreaSize;
  };
};

export type WorkbenchViewAreas = {
  primarySidebar?: Component;
  mainArea: Component;
  secondarySidebar?: Component;
  bottomPanel?: Component;
  mobileHeader?: Component;
};

export type WorkbenchView = {
  id: string;
  title: string;
  areas: WorkbenchViewAreas;
  layout: WorkbenchViewLayout;
};

export type WorkbenchViewDefinition = Omit<WorkbenchView, "layout"> & {
  layout?: Partial<{
    mobile: Partial<WorkbenchViewLayout["mobile"]>;
    desktop: Partial<WorkbenchViewLayout["desktop"]>;
  }>;
};

export const defaultWorkbenchViewLayout: WorkbenchViewLayout = {
  mobile: {
    rootArea: "primarySidebar"
  },
  desktop: {
    primarySidebar: {}
  }
};

export function defineWorkbenchView(definition: WorkbenchViewDefinition): WorkbenchView {
  return {
    ...definition,
    layout: {
      mobile: {
        ...defaultWorkbenchViewLayout.mobile,
        ...definition.layout?.mobile
      },
      desktop: {
        ...defaultWorkbenchViewLayout.desktop,
        ...definition.layout?.desktop
      }
    }
  };
}

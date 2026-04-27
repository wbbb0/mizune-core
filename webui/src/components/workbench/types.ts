import type { Component } from "vue";

type WorkbenchSectionLayout = {
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
  layout: WorkbenchSectionLayout;
};

export type WorkbenchSectionDefinition = Omit<WorkbenchSection, "layout"> & {
  layout?: Partial<{
    mobile: Partial<WorkbenchSectionLayout["mobile"]>;
    desktop: Partial<WorkbenchSectionLayout["desktop"]>;
  }>;
};

export const defaultWorkbenchSectionLayout: WorkbenchSectionLayout = {
  mobile: {
    mainFlow: "list-main"
  },
  desktop: {
    listPane: {}
  }
};

export function defineWorkbenchSection(definition: WorkbenchSectionDefinition): WorkbenchSection {
  return {
    ...definition,
    layout: {
      mobile: {
        ...defaultWorkbenchSectionLayout.mobile,
        ...definition.layout?.mobile
      },
      desktop: {
        ...defaultWorkbenchSectionLayout.desktop,
        ...definition.layout?.desktop
      }
    }
  };
}

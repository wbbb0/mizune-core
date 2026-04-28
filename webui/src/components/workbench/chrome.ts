import type { Component } from "vue";
import type { MenuNode } from "./menu/types.js";

export type WorkbenchTopbarMenu = {
  id: string;
  label: string;
  resolveItems: () => MenuNode[];
};

export type WorkbenchStatusbarItem = {
  id: string;
  component: Component;
  props?: Record<string, unknown>;
};

export function createStatusbarMenuNodes(items: WorkbenchStatusbarItem[]): MenuNode[] {
  return items.map((item) => ({
    kind: "component" as const,
    id: item.id,
    component: item.component,
    props: item.props
  }));
}

import type { Component } from "vue";

export type WorkbenchNavItem = {
  id: string;
  title: string;
  icon: Component;
  placement: "primary" | "bottom";
};

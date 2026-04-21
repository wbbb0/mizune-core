import type { Component } from "vue";

export type MenuNode =
  | {
      kind: "action";
      id: string;
      label: string;
      icon?: Component;
      shortcut?: string;
      danger?: boolean;
      onSelect: () => void;
    }
  | {
      kind: "toggle";
      id: string;
      label: string;
      checked: boolean;
      onToggle: (next: boolean) => void;
    }
  | {
      kind: "radio";
      id: string;
      label: string;
      checked: boolean;
      onSelect: () => void;
    }
  | {
      kind: "submenu";
      id: string;
      label: string;
      icon?: Component;
      children: MenuNode[];
    }
  | {
      kind: "group";
      id: string;
      label?: string;
      children: MenuNode[];
    }
  | {
      kind: "separator";
      id: string;
    }
  | {
      kind: "component";
      id: string;
      component: Component;
      props?: Record<string, unknown>;
    };

export type MenuAnchor = { x: number; y: number } | { element: HTMLElement | null };

export type MenuSource = "mobile-workbench" | "topbar" | "statusbar" | "contextmenu";

export type MenuStackEntry = {
  id: string;
  items: MenuNode[];
  anchor: MenuAnchor;
  source: MenuSource;
  parentId?: string;
};

import type { Component } from "vue";

/** Workbench 菜单树节点。顶部菜单、状态栏菜单和上下文菜单共用同一结构。 */
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

/** 菜单定位锚点。可使用固定坐标，也可绑定到触发元素。 */
export type MenuAnchor = { x: number; y: number } | { element: HTMLElement | null };

/** 菜单来源，用于移动端整合、定位策略和行为测试。 */
export type MenuSource = "mobile-workbench" | "topbar" | "statusbar" | "contextmenu";

/** 当前打开菜单栈中的一层。子菜单通过 parentId 关联父层。 */
export type MenuStackEntry = {
  id: string;
  items: MenuNode[];
  anchor: MenuAnchor;
  source: MenuSource;
  parentId?: string;
};

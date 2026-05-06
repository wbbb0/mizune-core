import type { Component } from "vue";
import type { MenuNode } from "./menu/types.js";

/** 顶部菜单定义。菜单项每次打开时通过 resolveItems 动态生成。 */
export type WorkbenchTopbarMenu = {
  id: string;
  label: string;
  resolveItems: () => MenuNode[];
};

/** 状态栏组件项。移动端菜单可把状态栏项转换成 component menu node。 */
export type WorkbenchStatusbarItem = {
  id: string;
  component: Component;
  props?: Record<string, unknown>;
};

/** 把状态栏组件项转换成菜单系统可渲染的 component node。 */
export function createStatusbarMenuNodes(items: WorkbenchStatusbarItem[]): MenuNode[] {
  return items.map((item) => ({
    kind: "component" as const,
    id: item.id,
    component: item.component,
    ...(item.props === undefined ? {} : { props: item.props })
  }));
}

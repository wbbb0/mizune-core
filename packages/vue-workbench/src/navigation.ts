import type { Component } from "vue";

/** Activity bar 中的一项导航入口。路由行为由业务项目处理。 */
export type WorkbenchNavItem = {
  /** 稳定 ID，通常与业务路由 name 或 section id 对齐。 */
  id: string;
  /** 鼠标悬浮和辅助技术使用的标题。 */
  title: string;
  /** lucide-vue-next 或业务自定义图标组件。 */
  icon: Component;
  /** primary 显示在主导航区，bottom 显示在底部区域。 */
  placement: "primary" | "bottom";
};

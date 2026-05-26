import type { Component } from "vue";

export type ResizableDisclosureSection = {
  id: string;
  title?: string;
  meta?: string;
  icon?: Component;
  expanded?: boolean;
  weight?: number;
  [key: string]: unknown;
};

export type ResizableDisclosureLayout = Record<string, {
  expanded: boolean;
  weight: number;
}>;

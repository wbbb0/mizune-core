import type { WorkbenchView } from "@/components/workbench/types";
import { workbenchViews } from "@/sections/registry";

export type { WorkbenchView } from "@/components/workbench/types";

export type WorkbenchRegistry = {
  workbenchViews: readonly WorkbenchView[];
  viewsById: ReadonlyMap<string, WorkbenchView>;
  getViewById(id: string): WorkbenchView;
};

const viewsById: ReadonlyMap<string, WorkbenchView> = new Map(
  workbenchViews.map((view) => [view.id, view] as const)
);

export function useWorkbenchViewRegistry(): WorkbenchRegistry {
  function getViewById(id: string): WorkbenchView {
    const view = viewsById.get(id);
    if (!view) {
      throw new Error(`Unknown workbench view: ${id}`);
    }
    return view;
  }

  return {
    workbenchViews,
    viewsById,
    getViewById
  };
}

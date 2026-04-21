import type { WorkbenchSection } from "@/components/workbench/types";
import { workbenchSections } from "@/sections/registry";

export type { WorkbenchSection } from "@/components/workbench/types";

export type WorkbenchRegistry = {
  workbenchSections: readonly WorkbenchSection[];
  sectionsById: ReadonlyMap<string, WorkbenchSection>;
  getSectionById(id: string): WorkbenchSection;
};

const sectionsById: ReadonlyMap<string, WorkbenchSection> = new Map(
  workbenchSections.map((section) => [section.id, section] as const)
);

export function useWorkbenchRegistry(): WorkbenchRegistry {
  function getSectionById(id: string): WorkbenchSection {
    const section = sectionsById.get(id);
    if (!section) {
      throw new Error(`Unknown workbench section: ${id}`);
    }
    return section;
  }

  return {
    workbenchSections,
    sectionsById,
    getSectionById
  };
}

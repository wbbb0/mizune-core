import { createSharedSectionState } from "./sharedSectionState";
import { createSkillsState } from "./skillsState";
export const useSkillsSection = createSharedSectionState(createSkillsState);

import { defineWorkbenchView } from "@workbench-kit/vue";
import SkillsListPane from "./SkillsListPane.vue";
import SkillsMainPane from "./SkillsMainPane.vue";
export const skillsView = defineWorkbenchView({ id: "skills", title: "技能", areas: { primarySidebar: SkillsListPane, mainArea: SkillsMainPane } });

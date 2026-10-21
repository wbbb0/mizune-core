import { api } from "./client.ts";
import type { SkillRecord, SkillSummary } from "../../../src/types/skills.ts";

export type { SkillRecord, SkillSummary };
export interface SkillCatalog {
  skills: SkillSummary[];
  config: { enabled: boolean; modelMaintenanceEnabled: boolean; plannerSelectionEnabled: boolean; maxCount: number; maxActiveSkills: number; maxBodyTokens: number; maxResourceTokens: number };
  toolsets: Array<{ id: string; title: string; description: string }>;
}
export type SkillDraft = Pick<SkillRecord, "document" | "resources" | "toolsetIds" | "userPolicy" | "modelEditable" | "modelPaused" | "modelPauseReason" | "changeReason">;
const path = (id: string) => `/api/skills/${encodeURIComponent(id)}`;
export const skillsApi = {
  list: () => api.get<SkillCatalog>("/api/skills"),
  get: (id: string, revision?: number) => api.get<{ skill: SkillRecord }>(path(id) + (revision == null ? "" : `?revision=${revision}`)),
  save: (id: string, expectedRevision: number | null, draft: SkillDraft) => api.put<{ skill: SkillRecord }>(path(id), { ...draft, expectedRevision }),
  remove: (id: string, expectedRevision: number) => api.delete<void>(path(id), { expectedRevision }),
  history: (id: string) => api.get<{ versions: SkillSummary[] }>(`${path(id)}/history`),
  rollback: (id: string, expectedRevision: number, revision: number) => api.post<{ skill: SkillRecord }>(`${path(id)}/rollback`, { expectedRevision, revision })
};

/** 实例级技能的管理与会话观测契约。 */
export interface SkillRecord {
  id: string;
  revision: number;
  name: string;
  description: string;
  document: string;
  resources: Record<string, string>;
  toolsetIds: string[];
  userPolicy: "auto" | "disabled";
  modelEditable: boolean;
  modelPaused: boolean;
  modelPauseReason: string | null;
  changeReason: string;
  updatedAt: number;
  updatedBy: "user" | "model" | "builtin";
}
export interface SkillSummary extends Omit<SkillRecord, "document" | "resources"> {
  resourcePaths: string[];
  bodyTokens: number;
  effectiveAvailable: boolean;
  unavailableReason: string | null;
}
export interface SkillWriteInput {
  expectedRevision: number | null;
  document: string;
  resources: Record<string, string>;
  toolsetIds: string[];
  userPolicy: "auto" | "disabled";
  modelEditable: boolean;
  modelPaused: boolean;
  modelPauseReason?: string | null;
  changeReason?: string;
}
export interface SkillLoadView {
  id: string;
  revision: number;
  name: string;
  reason: string;
  loaded: true;
  bodyTokens: number;
}
export interface SessionSkillsView {
  taskId: string | null;
  loaded: SkillLoadView[];
  rejected: Array<{
    id: string;
    reason: string;
  }>;
  catalogRevision: string;
}

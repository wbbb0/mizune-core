import type { ComfyTemplateConfig } from "#config/configModel.ts";

export interface ComfyResolvedTemplate {
  id: string;
  label: string;
  description: string | null;
  workflowFile: string;
  absoluteWorkflowPath: string;
  workflow: Record<string, unknown>;
  parameterBindings: ComfyTemplateConfig["parameterBindings"];
  resultPolicy: ComfyTemplateConfig["resultPolicy"];
}

export interface ComfyPromptSubmitResult {
  promptId: string;
  queueNumber: number;
  nodeErrors: Record<string, unknown>;
}

export interface ComfyHistoryImageResult {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyHistoryEntry {
  promptId: string;
  completed: boolean;
  status: string;
  images: ComfyHistoryImageResult[];
}

export interface ComfyTaskResultFile {
  filename: string;
  subfolder: string;
  type: string;
}

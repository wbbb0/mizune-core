import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { ComfyResolvedTemplate } from "./types.ts";
import { assertJsonPointerExists } from "./workflowPatch.ts";

export class ComfyTemplateCatalogService {
  private templates = new Map<string, ComfyResolvedTemplate>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async init(): Promise<void> {
    await this.ensureTemplateRoot();
    await this.reload();
  }

  async reload(): Promise<void> {
    await this.ensureTemplateRoot();
    const next = new Map<string, ComfyResolvedTemplate>();
    const templateRoot = this.getTemplateRootAbsolutePath();

    for (const templateConfig of this.config.comfy.templates) {
      if (!templateConfig.enabled) {
        continue;
      }
      try {
        const absoluteWorkflowPath = resolve(templateRoot, templateConfig.workflowFile);
        const workflow = JSON.parse(await readFile(absoluteWorkflowPath, "utf8")) as Record<string, unknown>;
        assertJsonPointerExists(workflow, templateConfig.parameterBindings.positivePromptPath);
        assertJsonPointerExists(workflow, templateConfig.parameterBindings.widthPath);
        assertJsonPointerExists(workflow, templateConfig.parameterBindings.heightPath);
        next.set(templateConfig.id, {
          id: templateConfig.id,
          label: templateConfig.label,
          description: templateConfig.description ?? null,
          workflowFile: templateConfig.workflowFile,
          absoluteWorkflowPath,
          workflow,
          parameterBindings: templateConfig.parameterBindings,
          resultPolicy: templateConfig.resultPolicy
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            error,
            templateId: templateConfig.id,
            workflowFile: templateConfig.workflowFile
          },
          "comfy_template_load_failed"
        );
      }
    }

    this.templates = next;
  }

  listAvailableTemplates(): ComfyResolvedTemplate[] {
    return Array.from(this.templates.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  getTemplate(templateId: string): ComfyResolvedTemplate | null {
    return this.templates.get(templateId) ?? null;
  }

  getTemplateRootAbsolutePath(): string {
    return resolve(this.config.configRuntime.configDir, this.config.comfy.templateRoot);
  }

  private async ensureTemplateRoot(): Promise<void> {
    await mkdir(this.getTemplateRootAbsolutePath(), { recursive: true });
  }
}

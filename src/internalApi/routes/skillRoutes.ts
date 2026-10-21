import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config/config.ts";
import type { SkillWriteInput } from "../../types/skills.ts";
import { getSkillStore, SkillError } from "../../skills/skillStore.ts";
import { TOOLSET_DEFINITIONS } from "../../llm/tools/toolsetCatalog.ts";
export function registerSkillRoutes(app: FastifyInstance, config: AppConfig): void {
  const store = () => getSkillStore(config);
  app.get("/api/skills", async () => ({ skills: store().list(), config: config.skills, toolsets: TOOLSET_DEFINITIONS.map(({ id, title, description }) => ({ id, title, description })) }));
  app.get<{
    Params: {
      id: string;
    };
    Querystring: {
      revision?: string;
    };
  }>("/api/skills/:id", async (request) => {
    const skill = store().get(request.params.id, request.query.revision ? Number(request.query.revision) : undefined);
    if (!skill)
      throw new SkillError("技能不存在。", 404);
    return { skill };
  });
  app.get<{
    Params: {
      id: string;
    };
  }>("/api/skills/:id/history", async (request) => ({ versions: store().history(request.params.id) }));
  app.put<{
    Params: {
      id: string;
    };
    Body: SkillWriteInput;
  }>("/api/skills/:id", async (request) => ({ skill: store().write(request.params.id, request.body, "user") }));
  app.delete<{
    Params: {
      id: string;
    };
    Body: {
      expectedRevision: number;
    };
  }>("/api/skills/:id", async (request) => {
    store().delete(request.params.id, request.body.expectedRevision);
    return { ok: true };
  });
  app.post<{
    Params: {
      id: string;
    };
    Body: {
      expectedRevision: number;
      revision: number;
    };
  }>("/api/skills/:id/rollback", async (request) => ({ skill: store().rollback(request.params.id, request.body.expectedRevision, request.body.revision) }));
}

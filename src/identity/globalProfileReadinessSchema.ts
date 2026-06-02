import { s, type Infer } from "#data/schema/index.ts";

export const readinessStatusSchema = s.enum(["uninitialized", "ready"] as const).title("准备度");

export const globalProfileReadinessSchema = s.object({
  persona: readinessStatusSchema,
  rp: readinessStatusSchema,
  updatedAt: s.number().int().min(0).title("更新时间")
}).title("全局资料准备度")
  .describe("记录全局 persona 与 RP 资料的准备状态。")
  .strict();

export type GlobalProfileReadinessStatus = Infer<typeof readinessStatusSchema>;
export type GlobalProfileReadiness = Infer<typeof globalProfileReadinessSchema>;

export function createEmptyGlobalProfileReadiness(): GlobalProfileReadiness {
  return {
    persona: "uninitialized",
    rp: "uninitialized",
    updatedAt: Date.now()
  };
}

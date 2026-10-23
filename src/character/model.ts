import { randomUUID } from "node:crypto";
import { emptyValue, personaJsonSchema, socialJsonSchema, embodimentJsonSchema, socialStateJsonSchema, simulationJsonSchema, tierForMode, type JsonObject } from "./schemaCatalog.ts";

export const characterStages = ["persona", "social", "embodiment", "state"] as const;
export type CharacterStage = typeof characterStages[number];
export interface CharacterProfile {
  revision: string;
  confirmed: CharacterStage[];
  persona: JsonObject;
  social: JsonObject;
  embodiment: JsonObject;
}
export interface CharacterSession {
  revision: string;
  initialized: boolean;
  social: JsonObject;
  simulation: JsonObject;
  events: Array<{ id: string; date: string; kind: string; summary: string }>;
  cycleConfig: string | null;
}
export interface CharacterDraft {
  id: string;
  stage: CharacterStage;
  phase: "setup" | "config";
  baseRevision: string;
  profileRevision: string;
  value: JsonObject;
  touched: string[];
  introduction: "pending" | "claimed";
}
export function emptyCharacter(): CharacterProfile {
  return { revision: randomUUID(), confirmed: [], persona: emptyValue(personaJsonSchema), social: emptyValue(socialJsonSchema), embodiment: emptyValue(embodimentJsonSchema) };
}
export function emptyCharacterSession(): CharacterSession {
  return { revision: randomUUID(), initialized: false, social: emptyValue(socialStateJsonSchema), simulation: emptyValue(simulationJsonSchema), events: [], cycleConfig: null };
}
export function nextCharacterStage(profile: CharacterProfile, state: CharacterSession, modeId: string): CharacterStage | null {
  const tier = tierForMode(modeId);
  const layers = characterStages.slice(0, tier);
  return layers.find(layer => !profile.confirmed.includes(layer)) ?? (tier === 3 && !state.initialized ? "state" : null);
}
export function stageRoot(profile: CharacterProfile, state: CharacterSession, stage: CharacterStage): JsonObject {
  return stage === "state" ? { social: state.social, simulation: state.simulation } : { [stage]: profile[stage] };
}

import { z } from "zod";

function withEmptyDefault<T extends z.ZodTypeAny>(schema: T) {
  return schema.default(() => schema.parse({}) as never);
}

export const statefulRpActivityKinds = [
  "resting",
  "sedentary",
  "walking",
  "active",
  "intimate",
  "grooming"
] as const;
export type StatefulRpActivityKind = (typeof statefulRpActivityKinds)[number];

export const statefulRpBodyPartKeys = [
  "head_neck",
  "chest",
  "waist_belly",
  "groin_hips",
  "thighs_legs",
  "feet"
] as const;
export type StatefulRpBodyPartKey = (typeof statefulRpBodyPartKeys)[number];

export const statefulRpClothingSlots = [
  "bra",
  "underwear",
  "hosiery",
  "top",
  "bottom",
  "dress",
  "outerwear",
  "footwear",
  "accessory"
] as const;
export type StatefulRpClothingSlot = (typeof statefulRpClothingSlots)[number];

export const statefulRpClothingLayers = [
  "intimate",
  "base",
  "mid",
  "outer",
  "footwear",
  "accessory"
] as const;
export type StatefulRpClothingLayer = (typeof statefulRpClothingLayers)[number];

export const statefulRpRelationshipStages = [
  "stranger",
  "acquaintance",
  "friend",
  "close_friend",
  "ambiguous",
  "crush",
  "lover",
  "estranged",
  "complicated"
] as const;
export type StatefulRpRelationshipStage = (typeof statefulRpRelationshipStages)[number];

export const statefulRpMaintenancePassNames = [
  "time_and_activity",
  "offscreen_autonomy",
  "embodiment_sensory",
  "mind_and_relation"
] as const;
export type StatefulRpMaintenancePassName = (typeof statefulRpMaintenancePassNames)[number];

export const statefulRpClockSchema = z.object({
  currentIso: z.string().min(1),
  timezone: z.string().min(1).default("Asia/Shanghai"),
  dayOfWeek: z.string().min(1).default("六"),
  timeOfDay: z.enum(["清晨", "上午", "中午", "下午", "傍晚", "夜晚", "深夜"]).default("下午"),
  minutesSinceLastEmbodimentTick: z.number().int().min(0).default(0),
  minutesSinceLastMindTick: z.number().int().min(0).default(0),
  lastActivityKind: z.enum(statefulRpActivityKinds).default("sedentary")
});
export type StatefulRpClockState = z.infer<typeof statefulRpClockSchema>;

export const statefulRpVitalsSchema = z.object({
  stamina: z.number().min(0).max(100).default(85),
  energy: z.number().min(0).max(100).default(85),
  hygiene: z.number().min(0).max(100).default(90),
  hunger: z.number().min(0).max(100).default(20),
  thirst: z.number().min(0).max(100).default(15),
  bladder: z.number().min(0).max(100).default(10),
  intoxication: z.number().min(0).max(100).default(0),
  pain: z.number().min(0).max(100).default(0),
  soreness: z.number().min(0).max(100).default(0),
  temperature: z.enum(["chilly", "cool", "comfortable", "warm", "hot", "feverish"]).default("comfortable"),
  heartRate: z.enum(["calm", "elevated", "racing", "pounding"]).default("calm"),
  statusEffects: z.array(z.string()).default([])
});
export type StatefulRpVitalsState = z.infer<typeof statefulRpVitalsSchema>;

export const statefulRpCycleSchema = z.object({
  dayOfCycle: z.number().int().min(1).max(35).default(14),
  cycleLength: z.number().int().min(21).max(35).default(28),
  phase: z.enum(["menstruation", "follicular", "ovulation", "luteal"]).default("ovulation"),
  symptomSeverity: z.number().min(0).max(100).default(5),
  notes: z.string().default("")
});
export type StatefulRpCycleState = z.infer<typeof statefulRpCycleSchema>;

export const statefulRpAppearanceSchema = z.object({
  makeupAndHair: z.string().default("整洁自然"),
  postureAndDemeanor: z.string().default("神态放松自然"),
  observable: z.array(z.string()).default([])
});
export type StatefulRpAppearanceState = z.infer<typeof statefulRpAppearanceSchema>;

export const statefulRpClothingItemSchema = z.object({
  id: z.string().min(1),
  slot: z.enum(statefulRpClothingSlots),
  layer: z.enum(statefulRpClothingLayers),
  name: z.string().min(1),
  material: z.string().default(""),
  fit: z.enum(["tight", "fitted", "loose", "sheer", "binding"]).default("fitted"),
  breathability: z.number().min(0).max(100).default(70),
  displacement: z
    .enum(["normal", "shifted", "unfastened", "pulled_aside", "rolled_up", "half_off"])
    .default("normal"),
  wornMinutes: z.number().int().min(0).default(0),
  wetness: z.number().min(0).max(100).default(0),
  secretionStain: z.number().min(0).max(100).default(0),
  odorIntensity: z.number().min(0).max(100).default(0),
  odorNote: z.string().default(""),
  wrinkles: z.number().min(0).max(100).default(0),
  comfort: z.number().min(0).max(100).default(85),
  conditionNote: z.string().default("")
});
export type StatefulRpClothingItem = z.infer<typeof statefulRpClothingItemSchema>;

export const statefulRpIntimateGearSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.string().default("私密部位"),
  intensity: z.number().min(0).max(100).default(30),
  concealed: z.boolean().default(true),
  wornMinutes: z.number().int().min(0).default(0),
  effectNote: z.string().default("")
});
export type StatefulRpIntimateGear = z.infer<typeof statefulRpIntimateGearSchema>;

export const statefulRpPartSensationSchema = z.object({
  sensation: z.string().default(""),
  appearanceNote: z.string().default(""),
  scentNote: z.string().default(""),
  sensitivity: z.number().min(0).max(100).default(25),
  salience: z.number().min(0).max(100).default(10)
});
export type StatefulRpPartSensation = z.infer<typeof statefulRpPartSensationSchema>;

export const statefulRpPartSensationsMapSchema = z.object({
  head_neck: withEmptyDefault(statefulRpPartSensationSchema),
  chest: withEmptyDefault(statefulRpPartSensationSchema),
  waist_belly: withEmptyDefault(statefulRpPartSensationSchema),
  groin_hips: withEmptyDefault(statefulRpPartSensationSchema),
  thighs_legs: withEmptyDefault(statefulRpPartSensationSchema),
  feet: withEmptyDefault(statefulRpPartSensationSchema)
});
export type StatefulRpPartSensationsMap = z.infer<typeof statefulRpPartSensationsMapSchema>;

export const statefulRpIntimatePhysiologySchema = z.object({
  lubrication: z.number().min(0).max(100).default(5),
  muscleTension: z.number().min(0).max(100).default(10),
  lingeringSimulation: z.string().default(""),
  secretionNote: z.string().default("")
});
export type StatefulRpIntimatePhysiology = z.infer<typeof statefulRpIntimatePhysiologySchema>;

const statefulRpOutfitSchema = z.object({
  presetName: z.string().default("日常穿搭"),
  items: z.array(statefulRpClothingItemSchema).default([]),
  intimateGear: z.array(statefulRpIntimateGearSchema).default([]),
  overallImpact: z.string().default("衣着整洁贴合，尚无明显不适")
});

export const statefulRpEmbodimentSchema = z.object({
  vitals: withEmptyDefault(statefulRpVitalsSchema),
  cycle: withEmptyDefault(statefulRpCycleSchema),
  appearance: withEmptyDefault(statefulRpAppearanceSchema),
  outfit: withEmptyDefault(statefulRpOutfitSchema),
  partSensations: withEmptyDefault(statefulRpPartSensationsMapSchema),
  intimateState: withEmptyDefault(statefulRpIntimatePhysiologySchema)
});
export type StatefulRpEmbodimentState = z.infer<typeof statefulRpEmbodimentSchema>;

export const statefulRpIntentionSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  reason: z.string().default(""),
  priority: z.number().int().min(1).max(5).default(3),
  status: z.enum(["active", "completed", "fulfilled", "abandoned"]).default("active")
});
export type StatefulRpIntention = z.infer<typeof statefulRpIntentionSchema>;

const statefulRpEmotionSchema = z.object({
  primary: z.string().default("平静"),
  secondary: z.string().default(""),
  valence: z.number().min(-100).max(100).default(15),
  arousal: z.number().min(0).max(100).default(25),
  selfControl: z.number().min(0).max(100).default(80),
  triggers: z.array(z.string()).default([])
});

const statefulRpSurfaceVsInnerSchema = z.object({
  surfaceDemeanor: z.string().default("自然得体"),
  innerMonologue: z.string().default("观察对方反应，保持自然交流"),
  tension: z.number().min(0).max(100).default(15)
});

const statefulRpDesireSchema = z.object({
  arousal: z.number().min(0).max(100).default(10),
  longing: z.number().min(0).max(100).default(20),
  shame: z.number().min(0).max(100).default(10),
  frustration: z.number().min(0).max(100).default(5),
  focus: z.string().default("")
});

export const statefulRpMindSchema = z.object({
  emotion: withEmptyDefault(statefulRpEmotionSchema),
  surfaceVsInner: withEmptyDefault(statefulRpSurfaceVsInnerSchema),
  desire: withEmptyDefault(statefulRpDesireSchema),
  intrusiveThoughts: z.array(z.string()).default([]),
  intentions: z.array(statefulRpIntentionSchema).default([])
});
export type StatefulRpMindState = z.infer<typeof statefulRpMindSchema>;

export const statefulRpPromiseSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  createdAtIso: z.string().min(1),
  dueIso: z.string().optional(),
  status: z.enum(["pending", "fulfilled", "broken", "overdue"]).default("pending")
});
export type StatefulRpPromise = z.infer<typeof statefulRpPromiseSchema>;

const statefulRpBoundariesSchema = z.object({
  comfortLevel: z.string().default("日常亲近交谈，自然肢体接触视氛围而定"),
  hardLimits: z.array(z.string()).default([]),
  softLimits: z.array(z.string()).default([])
});

const statefulRpRelationTensionSchema = z.object({
  unresolvedFriction: z.number().min(0).max(100).default(0),
  romanticTension: z.number().min(0).max(100).default(20),
  jealousy: z.number().min(0).max(100).default(0),
  recentAfterglow: z.string().default("")
});

export const statefulRpRelationshipSchema = z.object({
  stage: z.enum(statefulRpRelationshipStages).default("acquaintance"),
  intimacy: z.number().min(0).max(100).default(35),
  trust: z.number().min(0).max(100).default(45),
  affection: z.number().min(0).max(100).default(40),
  respect: z.number().min(0).max(100).default(55),
  dominanceBalance: z.number().min(-100).max(100).default(0),
  boundaries: withEmptyDefault(statefulRpBoundariesSchema),
  tension: withEmptyDefault(statefulRpRelationTensionSchema),
  promises: z.array(statefulRpPromiseSchema).default([])
});
export type StatefulRpRelationshipState = z.infer<typeof statefulRpRelationshipSchema>;

export const statefulRpScheduleEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  startIso: z.string().min(1),
  endIso: z.string().min(1),
  location: z.string().default(""),
  status: z.enum(["pending", "completed", "missed", "cancelled"]).default("pending")
});
export type StatefulRpScheduleEntry = z.infer<typeof statefulRpScheduleEntrySchema>;

export const statefulRpWorldSchema = z.object({
  currentLocation: z.string().default("室内房间"),
  locationTags: z.array(z.string()).default(["室内", "私密"]),
  weather: z.string().default("晴朗温和"),
  isSeparated: z.boolean().default(false),
  presentNpcs: z.array(z.string()).default([]),
  ambientPressure: z.string().default(""),
  lastOffScreenSummary: z.string().default(""),
  schedule: z.array(statefulRpScheduleEntrySchema).default([])
});
export type StatefulRpWorldState = z.infer<typeof statefulRpWorldSchema>;

export const statefulRpJournalEntrySchema = z.object({
  id: z.string().min(1),
  clockIso: z.string().min(1),
  category: z.enum(["world", "embodiment", "mind", "relationship"]),
  summary: z.string().min(1)
});
export type StatefulRpJournalEntry = z.infer<typeof statefulRpJournalEntrySchema>;

export const statefulRpMaintenanceLogEntrySchema = z.object({
  id: z.string().min(1),
  clockIso: z.string().min(1),
  elapsedMinutes: z.number().int().min(0),
  passesRun: z.array(z.enum(statefulRpMaintenancePassNames)),
  summary: z.string()
});
export type StatefulRpMaintenanceLogEntry = z.infer<typeof statefulRpMaintenanceLogEntrySchema>;

export const statefulRpSessionStateSchema = z.object({
  version: z.literal(1).default(1),
  sessionId: z.string().optional(),
  initialized: z.boolean().default(false),
  updatedAt: z.string().optional(),
  clock: statefulRpClockSchema,
  embodiment: withEmptyDefault(statefulRpEmbodimentSchema),
  mind: withEmptyDefault(statefulRpMindSchema),
  relationship: withEmptyDefault(statefulRpRelationshipSchema),
  world: withEmptyDefault(statefulRpWorldSchema),
  journal: z.array(statefulRpJournalEntrySchema).default([]),
  maintenanceLog: z.array(statefulRpMaintenanceLogEntrySchema).default([])
});
export type StatefulRpSessionState = z.infer<typeof statefulRpSessionStateSchema>;

export function createInitialStatefulRpSessionState(input?: {
  sessionId?: string | undefined;
  startClockIso?: string | undefined;
}): StatefulRpSessionState {
  const startClockIso = input?.startClockIso?.trim() || "2026-05-16T14:00:00+08:00";
  return statefulRpSessionStateSchema.parse({
    version: 1,
    ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
    initialized: false,
    updatedAt: new Date().toISOString(),
    clock: {
      currentIso: startClockIso,
      timezone: "Asia/Shanghai",
      dayOfWeek: "六",
      timeOfDay: "下午",
      minutesSinceLastEmbodimentTick: 0,
      minutesSinceLastMindTick: 0,
      lastActivityKind: "sedentary"
    },
    embodiment: {
      outfit: {
        presetName: "日常穿搭",
        items: [
          {
            id: "bra-default",
            slot: "bra",
            layer: "intimate",
            name: "浅色蕾丝文胸",
            material: "棉混纺蕾丝",
            fit: "fitted",
            breathability: 75,
            wornMinutes: 180
          },
          {
            id: "underwear-default",
            slot: "underwear",
            layer: "intimate",
            name: "纯棉内裤",
            material: "纯棉",
            fit: "fitted",
            breathability: 80,
            wornMinutes: 180
          },
          {
            id: "hosiery-default",
            slot: "hosiery",
            layer: "base",
            name: "薄款连裤丝袜",
            material: "包芯丝尼龙",
            fit: "tight",
            breathability: 45,
            wornMinutes: 180
          },
          {
            id: "top-default",
            slot: "top",
            layer: "mid",
            name: "修身针织衫",
            material: "软针织棉",
            fit: "fitted",
            breathability: 75,
            wornMinutes: 180
          },
          {
            id: "bottom-default",
            slot: "bottom",
            layer: "mid",
            name: "高腰百褶半身裙",
            material: "西装混纺",
            fit: "fitted",
            breathability: 70,
            wornMinutes: 180
          }
        ]
      }
    }
  });
}

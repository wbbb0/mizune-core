import socialDocument from "../../../../src/character/schemas/tier2-social.schema.json" with { type: "json" };
import simulationDocument from "../../../../src/character/schemas/tier3-embodiment-and-simulation.schema.json" with { type: "json" };

export interface StateSchema {
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, StateSchema>;
  items?: StateSchema;
  additionalProperties?: boolean | StateSchema;
}

function expand(schema: StateSchema, document: unknown): StateSchema {
  if (schema.$ref) {
    const resolved = schema.$ref.slice(2).split("/").reduce((node: any, key) => node[key], document);
    const { $ref, ...annotations } = schema;
    return expand({ ...resolved, ...annotations }, document);
  }
  return {
    ...schema,
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, expand(child, document)])) } : {}),
    ...(schema.items ? { items: expand(schema.items, document) } : {})
  };
}
export const socialStateSchema = expand(socialDocument.properties.sessionState.properties.social, socialDocument);
export const simulationStateSchema = expand(simulationDocument.properties.sessionState.properties.simulation, simulationDocument);

const labels: Record<string, string> = {
  social: "社交", clock: "游戏时钟", scene: "场景", body: "身体", mind: "心理", relationships: "关系进展", schedule: "日程", wardrobe: "衣柜", journal: "状态日志",
  initialized: "开局已确认", participantRelationships: "参与者关系", recentEvents: "近期共同经历", promises: "约定与承诺", currentMood: "当前心情",
  currentIso: "游戏时间", timezone: "时区", location: "地点", active: "当前是否发生", lastStartDate: "上次开始日期", currentEndDate: "本次结束日期", nextStartDate: "下次开始日期",
  menstrualCycle: "周期状态（自动计算）", id: "编号", instanceId: "实例编号", itemId: "物品编号", participantId: "参与者编号", status: "状态", date: "日期", summary: "摘要", kind: "类型", category: "分类",
  instances: "物品实例", worn: "当前穿戴", acquiredItems: "本会话新增物品", definition: "物品定义", name: "名称", title: "标题", timeOfDay: "时段"
};
const enumLabels: Record<string, string> = {
  pending: "待完成", fulfilled: "已兑现", broken: "已违约", overdue: "已逾期", disabled: "已关闭", standard: "标准计算", narrative: "叙事规则",
  clothing: "衣物", accessory: "配饰", intimate_gear: "私密道具", intimate: "亲密", base: "贴身层", mid: "中间层", outer: "外层", footwear: "鞋袜", internal_or_attached: "内置或附着",
  resting: "休息", sedentary: "静坐", walking: "步行", active: "活动中", grooming: "整理仪容", together: "在一起", same_building_apart: "同处一栋建筑但分开", remote_online: "远程在线", offline_separated: "离线分开",
  chilly: "寒冷", cool: "偏凉", comfortable: "舒适", warm: "偏暖", hot: "炎热", feverish: "发热", calm: "平稳", elevated: "加快", racing: "急促", pounding: "强烈跳动",
  eager: "主动迎合", shy_consenting: "害羞默许", half_refusing_half_yielding: "半推半就", hesitant: "犹豫试探", reluctant: "勉强忍耐", refusing: "明确拒绝",
  abandoned: "已放弃", completed: "已完成", missed: "已错过", cancelled: "已取消", wardrobe: "衣柜", worn: "穿戴中", laundry: "待清洗", carried_in_bag: "随身携带", discarded_or_lost: "已丢弃或遗失",
  normal: "整齐", shifted: "移位", unfastened: "已解开", pulled_aside: "拨向一侧", rolled_up: "撩起或卷起", half_off: "半脱", scene: "场景", body: "身体", mind: "心理", relationship: "关系", intimacy: "亲密"
};
export function fieldLabel(key: string, schema?: StateSchema): string {
  return labels[key] ?? schema?.title ?? schema?.description?.split(/[。（(:：]/)[0]?.trim() ?? key;
}
export function scalarText(value: unknown, schema?: StateSchema): string {
  if (value === null || value === undefined || value === "") return "未指定";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (schema?.enum && typeof value === "string") return enumLabels[value] ?? value;
  return String(value);
}
export function schemaEntries(value: Record<string, unknown>, schema: StateSchema) {
  const keys = [...new Set([...Object.keys(schema.properties ?? {}), ...Object.keys(value)])];
  return keys.map(key => ({ key, label: fieldLabel(key, schema.properties?.[key]), value: value[key], schema: schema.properties?.[key] ?? {} }));
}
export function valueSummary(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未指定";
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === "object") return `${Object.values(value).filter(item => item !== null && item !== undefined && item !== "").length} 个字段`;
  return scalarText(value);
}

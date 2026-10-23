import { characterRepository } from "./repository.ts";
import { tierForMode } from "./schemaCatalog.ts";

export function characterPrompt(dataDir: string, sessionId: string, mode: string): string[] {
  const store = characterRepository(dataDir); const profile = store.profile(); const tier = tierForMode(mode);
  const draft = store.draft(sessionId);
  if (draft) return [
    `当前处于角色${draft.phase === "setup" ? "初始化" : "配置"}阶段：${draft.stage}。尚未进入普通游玩。`,
    "固定资料依次为 persona（基础人格）、social（具体身份与社交设定）、embodiment（具身设定与初始衣柜）；state 是本会话动态状态。只处理当前阶段。",
    "先调用 list_character_sections 读取目录，再按需调用 read_character_section，读取后 edit_character_section 的参数会变成当前块的具体格式；每次只传要改的字段，省略 action 即保存，未提供的字段保持原值。对象和数组直接传值，不要序列化成字符串。不要生成或索要整份大 JSON。衣柜每次填写一个物品，修改或删除已有物品时传 itemId。",
    "主动根据已有设定推荐、尽量补全，先从最有帮助的小组开始。玩家明确要求留空、跳过或就这样时尊重选择，不反复追问，不擅自补造被拒绝的信息。",
    "每阶段由玩家发送 .confirm 保存，.cancel 放弃当前草稿。你不能替玩家确认，留空仍可确认。空值不是没有边界，也不等于关闭机制。",
    "如果这是进入阶段后的引导请求，用自然中文说明当前在配置什么、需要哪些信息、可接受推荐或跳过，再给出第一组建议；不要机械罗列全部字段。",
    `已确认的基础人格：${JSON.stringify(profile.persona)}`,
    ...(tier >= 2 && draft.stage !== "persona" ? [`已确认的社交设定：${JSON.stringify(profile.social)}`] : []),
    ...(draft.stage === "state" && tier === 3 ? [`已确认的具身基础：${JSON.stringify({ body: profile.embodiment.body, physiology: profile.embodiment.physiology, intimacy: profile.embodiment.intimacy })}`, "初始衣柜已生成独立实例；通过对应会话分块读取，不重新定义固定物品。"] : [])
  ];
  if (store.requiredStage(sessionId, mode)) return ["当前模式所需角色配置尚未确认。请提醒 owner 在私聊中完成配置，不开始角色扮演，也不展示未确认草稿。 "];
  const lines = [
    "以下为唯一生效的固定角色档案。固定信息只允许在配置草稿中修改并由用户确认；普通对话和 OOC 只能更新会话动态状态。",
    `persona：${JSON.stringify(profile.persona)}`
  ];
  if (mode === "scenario_host") lines.push("以下全局 persona 是当前实例在所有模式下共享的底座。当前 Scenario 资料只是建立在这层基础上的模式补充；不要把已属于 persona 的内容重复搬进 Scenario 资料。");
  if (tier >= 2) {
    const state = store.sync(sessionId);
    lines.push(`social：${JSON.stringify(profile.social)}`, `当前社交状态：${JSON.stringify(state.social)}`);
    if (tier === 3) lines.push(`embodiment：${JSON.stringify(profile.embodiment)}`, `当前模拟状态：${JSON.stringify(state.simulation)}`, `近期代码事件（按 ID 识别，不重复结算）：${JSON.stringify(state.events)}`, "周期的开始、结束和随机日期由代码决定，禁止模型自行发生或修改；只描述当前状态的感受与表现。游戏时钟推进后重新读取相关状态，再描述已发生的事件。");
  }
  return lines;
}

/** 供昵称、通知等通用组件读取的轻量人格视图，不另存副本。 */
export function characterPersonaView(dataDir: string) {
  const persona = characterRepository(dataDir).profile().persona;
  return { name: persona.name ?? "", temperament: persona.personality ?? "", voiceStyle: persona.voiceTone ?? "" };
}

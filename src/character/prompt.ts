import { projectSocialForContext } from "./referenceImages.ts";
import { characterRepository } from "./repository.ts";
import { getCharacterSection, tierForMode } from "./schemaCatalog.ts";
import { setupEditBindings } from "./setupEditing.ts";

function referenceImageSetupGuide(draftId: string): string {
  const tools = setupEditBindings(getCharacterSection("social.referenceImages"), draftId);
  const updateTool = tools.find(tool => tool.action === "update")!.definition.function.name;
  const removeTool = tools.find(tool => tool.action === "remove")!.definition.function.name;
  return `若玩家明确将已登记图片指定为角色设定图、立绘或外观参考图（消息中带有 asset_ref 或 file_id），优先调用 import_character_reference 一步完成精读并写入 social.referenceImages 草稿（多人图需先确认或传入 subject），再依据返回的 description 辅助填写 social.appearance.overview 与 social.appearance.distinctiveFeatures；图中服装先向玩家汇报，待确认为稳定日常穿搭风格后再写入 clothingStyle。微调已导入条目的 label 或 description 使用 ${updateTool}（不可修改来源字段 fileId 与 subject），删除使用 ${removeTool}，均传已有条目的 itemId。`;
}

export function characterPrompt(dataDir: string, sessionId: string, mode: string): string[] {
  const store = characterRepository(dataDir); const profile = store.profile(); const tier = tierForMode(mode);
  const draft = store.draft(sessionId);
  if (draft) return [
    `当前处于角色${draft.phase === "setup" ? "初始化" : "配置"}阶段：${draft.stage}。尚未进入普通游玩。`,
    "固定资料依次为 persona（基础人格）、social（具体身份与社交设定）、embodiment（具身设定与初始衣柜）；state 是本会话动态状态。只处理当前阶段。",
    "当前配置阶段的全部分块编辑工具已经直接可用，不需要申请或加载工具组。直接使用分块专用填写工具，无需先读取；list_character_sections 和 read_character_section 仅按需查询目录与当前值（可只读当前阶段及已确认的前置固定设定，集合分块支持传 itemId 单条读取），不改变任何编辑工具，直接在参数顶层传要改的业务字段，未提供的字段保持原值；不要传 action、value、draftId 或分块 ID。工具名称稳定，由系统校验当前阶段和草稿。对象和数组直接传值，不要序列化成字符串。不要生成或索要整份大 JSON。衣柜与参考图使用分开的新增/修改、删除工具，每次处理一个条目；修改或删除已有条目时传 itemId。跳过使用独立工具，保留已填内容。",
    ...(draft.stage === "social" ? [referenceImageSetupGuide(draft.id)] : []),
    ...(draft.stage === "embodiment" ? [
      "如需参考已确认的角色设定图详尽视觉描述来整理初始衣柜（embodiment.wardrobe.items）或可见身体细节，可调用 read_character_section 读取 social.referenceImages（可传 itemId 单条读取）；仅提取画面明确可见特征，不编造精确身高、体重、年龄、三围或遮挡处细节。"
    ] : []),
    "主动根据已有设定推荐、尽量补全，先从最有帮助的小组开始。玩家明确要求留空、跳过或就这样时尊重选择，不反复追问，不擅自补造被拒绝的信息。",
    "每阶段由玩家发送 .confirm 保存，.cancel 放弃当前草稿。你不能替玩家确认，留空仍可确认。空值不是没有边界，也不等于关闭机制。",
    "玩家要求核对草稿，或本阶段填写完成准备请玩家确认时，调用 send_setup_draft 发送当前阶段的完整草稿。工具直接读取已保存的草稿，通常不传 content；content 仅用于补充说明，不要由你重写或摘要代替完整草稿。发送后等待玩家反馈或 .confirm，不自动确认，也不在同一回复继续追问新的长串字段。",
    "如果这是进入阶段后的引导请求，用自然中文说明当前在配置什么、需要哪些信息、可接受推荐或跳过，再给出第一组建议；不要机械罗列全部字段。",
    `已确认的基础人格：${JSON.stringify(profile.persona)}`,
    ...(tier >= 2 && draft.stage !== "persona" ? [`已确认的社交设定：${JSON.stringify(projectSocialForContext(profile.social))}`] : []),
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
    lines.push(
      `social：${JSON.stringify(projectSocialForContext(profile.social))}`,
      "social.referenceImages 在常驻上下文中仅保留轻量索引（id、fileId、label、subject）；需要核对设定图详尽文字描述时调用 read_character_section（id=\"social.referenceImages\"，可传 itemId 读取单条），需要生图、看图核对原图或发送原图时直接把对应 fileId 传给 generate_image（reference_images）、asset_media_view / asset_media_inspect 或 asset_send_to_chat。",
      `当前社交状态：${JSON.stringify(state.social)}`
    );
    if (tier === 3) lines.push(`embodiment：${JSON.stringify(profile.embodiment)}`, `当前模拟状态：${JSON.stringify(state.simulation)}`, `近期代码事件（按 ID 识别，不重复结算）：${JSON.stringify(state.events)}`, "周期的开始、结束和随机日期由代码决定，禁止模型自行发生或修改；只描述当前状态的感受与表现。游戏时钟推进后重新读取相关状态，再描述已发生的事件。");
  }
  return lines;
}

/** 供昵称、通知等通用组件读取的轻量人格视图，不另存副本。 */
export function characterPersonaView(dataDir: string) {
  const persona = characterRepository(dataDir).profile().persona;
  return { name: persona.name ?? "", temperament: persona.personality ?? "", voiceStyle: persona.voiceTone ?? "" };
}

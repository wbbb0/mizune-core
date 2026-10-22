import { formatIsoToDisplayClock } from "./clockAndRules.ts";
import {
  statefulRpBodyPartKeys,
  type StatefulRpBodyPartKey,
  type StatefulRpClothingItem,
  type StatefulRpSessionState
} from "./types.ts";

const BODY_PART_LABELS: Record<StatefulRpBodyPartKey, string> = {
  head_neck: "头颈与面颊",
  chest: "胸乳与锁骨",
  waist_belly: "腰腹与后腰",
  groin_hips: "私处与臀胯",
  thighs_legs: "大腿与腿部",
  feet: "足部与脚踝"
};

export function buildStatefulRpStateLines(state: StatefulRpSessionState): string[] {
  const { clock, embodiment, mind, relationship, world } = state;
  const displayClock = formatIsoToDisplayClock(clock.currentIso);
  const vitals = embodiment.vitals;
  const cycle = embodiment.cycle;

  const outfitSummary = formatOutfitItems(embodiment.outfit.items);
  const gearSummary = embodiment.outfit.intimateGear.length > 0
    ? embodiment.outfit.intimateGear
        .map((gear) => `${gear.name}[${gear.position};强度:${gear.intensity};持续:${gear.wornMinutes}m;${gear.concealed ? "隐蔽" : "外露"}]${gear.effectNote ? `(${gear.effectNote})` : ""}`)
        .join("；")
    : "无";

  const salientParts = statefulRpBodyPartKeys
    .map((key) => ({
      key,
      label: BODY_PART_LABELS[key],
      data: embodiment.partSensations[key]
    }))
    .filter(({ data }) => data.salience >= 15 || Boolean(data.sensation.trim()) || Boolean(data.scentNote.trim()))
    .sort((a, b) => b.data.salience - a.data.salience);

  const partSensationText = salientParts.length > 0
    ? salientParts
        .map(({ label, data }) => {
          const details = [
            data.sensation ? `体感:${data.sensation}` : "",
            data.appearanceNote ? `外观:${data.appearanceNote}` : "",
            data.scentNote ? `气味:${data.scentNote}` : "",
            `敏感:${data.sensitivity}/显著:${data.salience}`
          ].filter(Boolean).join("，");
          return `${label}[${details}]`;
        })
        .join("；")
    : "各部位体感平稳，无明显不适或异样刺激";

  const intimate = embodiment.intimateState;
  const intimateLine = [
    `润滑度=${intimate.lubrication}/100`,
    `肌肉紧绷=${intimate.muscleTension}/100`,
    intimate.lingeringSimulation ? `余韵/持续刺激=${intimate.lingeringSimulation}` : "",
    intimate.secretionNote ? `分泌物与痕迹=${intimate.secretionNote}` : ""
  ].filter(Boolean).join("；");

  const activeIntentions = mind.intentions.filter((item) => item.status === "active");
  const pendingPromises = relationship.promises.filter((item) => item.status === "pending" || item.status === "overdue");
  const pendingSchedule = world.schedule.filter((item) => item.status === "pending");
  const recentJournal = state.journal.slice(-5);

  return [
    `初始化状态=${state.initialized ? "已初始化" : "未初始化（首轮互动请先调用 stateful_rp_init）"}`,
    `时间与活动=${displayClock}（时段:${clock.timeOfDay}，周${clock.dayOfWeek}，当前活动:${clock.lastActivityKind}，距上次体态结算:${clock.minutesSinceLastEmbodimentTick}m，距上次心理结算:${clock.minutesSinceLastMindTick}m）`,
    `场景与空间=地点:${world.currentLocation}（${world.locationTags.join("/") || "无标签"}）｜天气:${world.weather}｜同处状态:${world.isSeparated ? "异地分开" : "同处一地"}｜在场人员:${world.presentNpcs.join("、") || "仅双方"}｜周边压力:${world.ambientPressure || "无"}`,
    world.lastOffScreenSummary ? `最近独处/后台经历=${world.lastOffScreenSummary}` : null,
    `生理指标=体力:${vitals.stamina}/100，精力:${vitals.energy}/100，清洁度:${vitals.hygiene}/100，饥饿:${vitals.hunger}/100，口渴:${vitals.thirst}/100，便意/憋尿:${vitals.bladder}/100，体温感:${vitals.temperature}，心率感:${vitals.heartRate}${vitals.statusEffects.length > 0 ? `，附加状态:${vitals.statusEffects.join("、")}` : ""}`,
    `生理周期=第${cycle.dayOfCycle}/${cycle.cycleLength}天（阶段:${cycle.phase}，经期不适:${cycle.symptomSeverity}/100${cycle.notes ? `，备注:${cycle.notes}` : ""}）`,
    `可见体态与神情=妆容发型:${embodiment.appearance.makeupAndHair}｜体态神情:${embodiment.appearance.postureAndDemeanor}｜外显线索:${embodiment.appearance.observable.join("、") || "无"}`,
    `当前穿戴（预设:${embodiment.outfit.presetName}）=${outfitSummary}`,
    `私密配饰与道具=${gearSummary}`,
    `穿戴综合体感=${embodiment.outfit.overallImpact || "正常贴合"}`,
    `分部位身体感官（按显著度排序）=${partSensationText}`,
    `私密生理状态=${intimateLine}`,
    `表里情绪与反差=基础情绪:${mind.emotion.primary}${mind.emotion.secondary ? `/${mind.emotion.secondary}` : ""}（效价:${mind.emotion.valence}，唤醒:${mind.emotion.arousal}，自控力:${mind.emotion.selfControl}/100）｜外在伪装:${mind.surfaceVsInner.surfaceDemeanor}｜内心真实:${mind.surfaceVsInner.innerMonologue}（表里张力:${mind.surfaceVsInner.tension}/100）`,
    `欲望与羞耻=情欲唤醒:${mind.desire.arousal}/100，情感渴望:${mind.desire.longing}/100，羞耻感:${mind.desire.shame}/100，欲求不满/煎熬:${mind.desire.frustration}/100（焦点:${mind.desire.focus || "无"}）`,
    `侵入性杂念=${mind.intrusiveThoughts.length > 0 ? mind.intrusiveThoughts.join("；") : "无"}`,
    `短期微意图=${activeIntentions.length > 0 ? activeIntentions.map((item) => `[P${item.priority}]${item.goal}(原因:${item.reason})`).join("；") : "无"}`,
    `关系与互动边界=阶段:${relationship.stage}｜亲密度:${relationship.intimacy}/100，信任:${relationship.trust}/100，依恋:${relationship.affection}/100，尊重:${relationship.respect}/100，顺从/主导倾向:${relationship.dominanceBalance}｜舒适边界:${relationship.boundaries.comfortLevel}｜近期余韵:${relationship.tension.recentAfterglow || "无"}（未解心结:${relationship.tension.unresolvedFriction}/100，暧昧张力:${relationship.tension.romanticTension}/100，嫉妒:${relationship.tension.jealousy}/100）`,
    `约定与待办=${pendingPromises.length > 0 ? pendingPromises.map((item) => `${item.content}[${item.status}${item.dueIso ? `,截止:${formatIsoToDisplayClock(item.dueIso)}` : ""}]`).join("；") : "无"}｜近期日程=${pendingSchedule.length > 0 ? pendingSchedule.map((item) => `${item.title}@${item.location}(${formatIsoToDisplayClock(item.startIso)}~${formatIsoToDisplayClock(item.endIso)})`).join("；") : "无"}`,
    `近期状态日志=${recentJournal.length > 0 ? recentJournal.map((item) => `[${formatIsoToDisplayClock(item.clockIso)}/${item.category}]${item.summary}`).join("；") : "无"}`
  ].filter((line): line is string => Boolean(line));
}

export function buildStatefulRpPlannerSignalLine(
  state: StatefulRpSessionState | null,
  latestUserText: string
): string {
  const trimmed = latestUserText.trim();
  const isOocDirective = trimmed.startsWith("#");
  if (!state || !state.initialized) {
    return `stateful_rp信号：初始化=未完成；场外指令=${isOocDirective ? "是(#开头)" : "否"}；建议=首轮初始化或含#场外导演指令优先选用 reply_large 并启用工具。`;
  }

  const maxPartSalience = Math.max(
    0,
    ...statefulRpBodyPartKeys.map((key) => state.embodiment.partSensations[key].salience)
  );
  const topSalientParts = statefulRpBodyPartKeys
    .filter((key) => state.embodiment.partSensations[key].salience >= 50)
    .map((key) => `${BODY_PART_LABELS[key]}(${state.embodiment.partSensations[key].salience})`);

  const hasIntimateGear = state.embodiment.outfit.intimateGear.length > 0;
  const highTension =
    state.mind.surfaceVsInner.tension >= 60
    || state.mind.desire.arousal >= 55
    || state.mind.desire.shame >= 60
    || state.relationship.tension.unresolvedFriction >= 50
    || state.relationship.tension.romanticTension >= 60
    || maxPartSalience >= 60
    || hasIntimateGear;

  return [
    `stateful_rp信号：场外指令=${isOocDirective ? "是(#开头)" : "否"}`,
    `表里张力=${state.mind.surfaceVsInner.tension}`,
    `情欲=${state.mind.desire.arousal}/羞耻=${state.mind.desire.shame}`,
    `最高体感显著度=${maxPartSalience}${topSalientParts.length > 0 ? `[${topSalientParts.join(",")}]` : ""}`,
    `私密道具=${hasIntimateGear ? "有" : "无"}`,
    `高张力/感官复杂=${highTension ? "是(建议优先 reply_large)" : "否(日常闲聊可用 reply_small)"}`
  ].join("；");
}

function formatOutfitItems(items: StatefulRpClothingItem[]): string {
  if (items.length === 0) {
    return "未穿戴衣物";
  }
  return items
    .map((item) => {
      const states: string[] = [`已穿${item.wornMinutes}m`];
      if (item.displacement !== "normal") {
        states.push(`状态:${item.displacement}`);
      }
      if (item.wetness >= 15) {
        states.push(`汗湿/潮湿:${item.wetness}`);
      }
      if (item.secretionStain >= 15) {
        states.push(`分泌物痕迹:${item.secretionStain}`);
      }
      if (item.odorIntensity >= 15 || item.odorNote) {
        states.push(`气味:${item.odorIntensity}${item.odorNote ? `(${item.odorNote})` : ""}`);
      }
      if (item.comfort <= 65) {
        states.push(`舒适度:${item.comfort}`);
      }
      return `[${item.layer}/${item.slot}]${item.name}(${item.material}${item.fit ? `,${item.fit}` : ""}${item.conditionNote ? `,${item.conditionNote}` : ""}｜${states.join(",")})`;
    })
    .join("；");
}

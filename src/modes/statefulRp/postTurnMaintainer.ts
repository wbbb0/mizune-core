import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

function nanoid(len = 8): string {
  return randomUUID().replace(/-/g, "").slice(0, len);
}
import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import {
  applyDeterministicTimeTick,
  clamp,
  formatIsoToDisplayClock
} from "./clockAndRules.ts";
import type { StatefulRpStateStore } from "./stateStore.ts";
import {
  statefulRpActivityKinds,
  statefulRpBodyPartKeys,
  statefulRpJournalEntrySchema,
  statefulRpMaintenanceLogEntrySchema,
  type StatefulRpActivityKind,
  type StatefulRpBodyPartKey,
  type StatefulRpMaintenancePassName,
  type StatefulRpSessionState
} from "./types.ts";

export interface StatefulRpPostTurnInput {
  sessionId: string;
  userText: string;
  assistantText: string;
  personaName: string;
  rpBackgroundSummary?: string;
  clockBeforeTurnIso?: string | null;
  outfitSignatureBeforeTurn?: string | null;
  abortSignal?: AbortSignal;
}

export class StatefulRpPostTurnMaintainer {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly stateStore: StatefulRpStateStore,
    private readonly logger: Logger
  ) {}

  async runPostTurn(input: StatefulRpPostTurnInput): Promise<StatefulRpSessionState | null> {
    if (this.config.statefulRp && !this.config.statefulRp.postTurnMaintenanceEnabled) {
      return null;
    }
    if (input.abortSignal?.aborted) {
      return null;
    }

    const current = await this.stateStore.ensure(input.sessionId);
    const passesRun: StatefulRpMaintenancePassName[] = [];
    const summaryParts: string[] = [];

    let workingState: StatefulRpSessionState = structuredClone(current);
    workingState.initialized = true;

    const currentOutfitSig = buildOutfitSignature(workingState);
    const outfitModifiedInTurn = Boolean(
      input.outfitSignatureBeforeTurn && input.outfitSignatureBeforeTurn !== currentOutfitSig
    );
    const clockExplicitlyAdvanced = Boolean(
      input.clockBeforeTurnIso && input.clockBeforeTurnIso !== workingState.clock.currentIso
    );

    // =========================================================================
    // Pass 1: 时间流逝与活动判定 + 确定性数学结算
    // =========================================================================
    let elapsedMinutes = 0;
    let activityKind: StatefulRpActivityKind = workingState.clock.lastActivityKind;
    let isSeparated = workingState.world.isSeparated;
    let hasDueSchedule = false;

    if (clockExplicitlyAdvanced && input.clockBeforeTurnIso) {
      const diffMs = Date.parse(workingState.clock.currentIso) - Date.parse(input.clockBeforeTurnIso);
      elapsedMinutes = Math.max(1, Math.round(diffMs / 60_000));
      const nowMs = Date.parse(workingState.clock.currentIso);
      hasDueSchedule = workingState.world.schedule.some(
        (entry) => entry.status === "pending" && Date.parse(entry.startIso) <= nowMs
      );
      for (const promise of workingState.relationship.promises) {
        if (promise.status === "pending" && promise.dueIso && Date.parse(promise.dueIso) < nowMs) {
          promise.status = "overdue";
        }
      }
      passesRun.push("time_and_activity");
      summaryParts.push(`主模型已显式推进时间 +${elapsedMinutes}m(${activityKind})`);
    } else {
      const pass1 = await this.runTimeAndActivityPass(workingState, input);
      if (input.abortSignal?.aborted) {
        return null;
      }
      elapsedMinutes = pass1.elapsedMinutes;
      activityKind = pass1.activityKind;
      isSeparated = pass1.isSeparated;
      const ticked = applyDeterministicTimeTick(workingState, {
        elapsedMinutes,
        activityKind,
        isSeparated
      });
      workingState = ticked.nextState;
      hasDueSchedule = ticked.dueScheduleIds.length > 0;
      passesRun.push("time_and_activity");
      summaryParts.push(`时间+${elapsedMinutes}m(${activityKind}${pass1.reason ? `:${pass1.reason}` : ""})`);
    }

    // =======================================================================
    // Pass 2: 异地/长间隔独处自治结算（按条件触发）
    // =======================================================================
    if ((workingState.world.isSeparated && elapsedMinutes >= 60) || hasDueSchedule) {
      workingState = await this.runOffScreenAutonomyPass(workingState, elapsedMinutes, input);
      if (input.abortSignal?.aborted) {
        return null;
      }
      passesRun.push("offscreen_autonomy");
      summaryParts.push("完成异地独处自治结算");
    }

    // =========================================================================
    // Pass 3: 服饰物理与分部位感官维护（按游戏内每 30 分钟或换装/亲密互动触发）
    // =========================================================================
    const embodimentTickThreshold = this.config.statefulRp?.embodimentTickMinutes ?? 30;
    const shouldRunEmbodimentPass =
      workingState.clock.minutesSinceLastEmbodimentTick >= embodimentTickThreshold
      || outfitModifiedInTurn
      || activityKind === "intimate";

    if (shouldRunEmbodimentPass) {
      workingState = await this.runEmbodimentSensoryPass(workingState, input);
      if (input.abortSignal?.aborted) {
        return null;
      }
      workingState.clock.minutesSinceLastEmbodimentTick = 0;
      passesRun.push("embodiment_sensory");
      summaryParts.push("更新服饰久穿物理状态与身体分部位感受");
    }

    // =========================================================================
    // Pass 4: 心理转化与关系余韵维护（按游戏内每 30 分钟或高显著感官触发）
    // =========================================================================
    const mindTickThreshold = this.config.statefulRp?.mindTickMinutes ?? 30;
    const maxPartSalience = Math.max(
      0,
      ...statefulRpBodyPartKeys.map((key) => workingState.embodiment.partSensations[key].salience)
    );
    const hasOverduePromises = workingState.relationship.promises.some((item) => item.status === "overdue");
    const shouldRunMindPass =
      workingState.clock.minutesSinceLastMindTick >= mindTickThreshold
      || (shouldRunEmbodimentPass && maxPartSalience >= 55)
      || hasOverduePromises;

    if (shouldRunMindPass) {
      workingState = await this.runMindAndRelationPass(workingState, input);
      if (input.abortSignal?.aborted) {
        return null;
      }
      workingState.clock.minutesSinceLastMindTick = 0;
      passesRun.push("mind_and_relation");
      summaryParts.push("更新体感转化心理反差与短期意图");
    }

    if (input.abortSignal?.aborted) {
      return null;
    }

    workingState.maintenanceLog.push(statefulRpMaintenanceLogEntrySchema.parse({
      id: nanoid(8),
      clockIso: workingState.clock.currentIso,
      elapsedMinutes,
      passesRun,
      summary: summaryParts.join("；")
    }));

    return this.stateStore.write(input.sessionId, workingState);
  }

  private resolveMaintenanceModelRefs(): string[] {
    const plannerRefs = getModelRefsForRole(this.config, "turn_planner");
    if (plannerRefs.length > 0) {
      return plannerRefs;
    }
    const summarizerRefs = getModelRefsForRole(this.config, "summarizer");
    if (summarizerRefs.length > 0) {
      return summarizerRefs;
    }
    return getModelRefsForRole(this.config, "main_small");
  }

  private async callJsonPass(
    passName: StatefulRpMaintenancePassName,
    systemPrompt: string,
    userPrompt: string,
    abortSignal?: AbortSignal
  ): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.llmClient.generate({
        modelRefOverride: this.resolveMaintenanceModelRefs(),
        timeoutMsOverride: Math.max(8_000, this.config.llm.turnPlanner.timeoutMs),
        maxOutputTokensOverride: 900,
        enableThinkingOverride: false,
        preferNativeNoThinkingChatEndpoint: true,
        skipDebugDump: true,
        ...(abortSignal ? { abortSignal } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      });
      const parsed = parseFirstJsonObject(result.text);
      if (!parsed) {
        this.logger.warn({ passName }, "stateful_rp_post_turn_pass_invalid_json");
      }
      return parsed;
    } catch (error: unknown) {
      this.logger.warn({ passName, err: error }, "stateful_rp_post_turn_pass_failed");
      return null;
    }
  }

  private async runTimeAndActivityPass(
    state: StatefulRpSessionState,
    input: StatefulRpPostTurnInput
  ): Promise<{
    elapsedMinutes: number;
    activityKind: StatefulRpActivityKind;
    isSeparated: boolean;
    reason: string;
  }> {
    const systemPrompt = [
      "你是沉浸状态角色扮演（stateful_rp）的后置时间与活动判定器。",
      "请只根据本轮对话内容判断刚刚这一轮互动在剧情内自然流逝了多少分钟（elapsedMinutes）、主要活动类型（activityKind）以及双方当前是否处于异地分开状态（isSeparated）。",
      "输出严格的 JSON 对象，不要输出任何额外说明或 Markdown 代码块之外的文字：",
      '{"elapsedMinutes": number, "activityKind": "resting"|"sedentary"|"walking"|"active"|"intimate"|"grooming", "isSeparated": boolean, "reason": "简短原因"}',
      "参考尺度：简短一两句对白约 1~3 分钟；一段连续动作或交谈约 3~10 分钟；移动、用餐、洗漱约 15~45 分钟；明确说“几小时后/到了晚上/睡醒”则按实际跨度估算。"
    ].join("\n");

    const userPrompt = [
      `当前游戏时间：${formatIsoToDisplayClock(state.clock.currentIso)}（${state.clock.timeOfDay}）`,
      `当前地点：${state.world.currentLocation}（此前分开状态：${state.world.isSeparated ? "是" : "否"}）`,
      `玩家输入：${input.userText}`,
      `角色回复：${input.assistantText}`
    ].join("\n");

    const parsed = await this.callJsonPass("time_and_activity", systemPrompt, userPrompt, input.abortSignal);
    const rawMinutes = typeof parsed?.elapsedMinutes === "number" ? parsed.elapsedMinutes : 2;
    const elapsedMinutes = clamp(Math.round(rawMinutes), 1, 1440);
    const rawKind = typeof parsed?.activityKind === "string" ? parsed.activityKind : state.clock.lastActivityKind;
    const activityKind: StatefulRpActivityKind = (statefulRpActivityKinds as readonly string[]).includes(rawKind)
      ? (rawKind as StatefulRpActivityKind)
      : state.clock.lastActivityKind;
    const isSeparated = typeof parsed?.isSeparated === "boolean"
      ? parsed.isSeparated
      : state.world.isSeparated;
    const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";

    return {
      elapsedMinutes,
      activityKind,
      isSeparated,
      reason
    };
  }

  private async runOffScreenAutonomyPass(
    state: StatefulRpSessionState,
    elapsedMinutes: number,
    input: StatefulRpPostTurnInput
  ): Promise<StatefulRpSessionState> {
    const next = structuredClone(state);
    const systemPrompt = [
      "你是沉浸状态角色扮演（stateful_rp）的异地/独处自治模拟器。",
      "当角色与玩家处于分开状态并经过较长时间，或到达日程节点时，推断角色在独处期间自己做了什么（例如：因为出汗黏腻去洗澡换上居家服、完成日程安排、休息等）。",
      "只输出严格 JSON：",
      '{"currentLocation": "当前地点", "bathedAndCleaned": boolean, "changedOutfitPreset": "如换装则填新穿搭名否则空字符串", "lastOffScreenSummary": "1-2句描述她独处期间做的事与刚重逢/当前的状态"}'
    ].join("\n");

    const userPrompt = [
      `角色名：${input.personaName}`,
      `流逝时间：${elapsedMinutes} 分钟，当前时间：${formatIsoToDisplayClock(next.clock.currentIso)}`,
      `当前地点：${next.world.currentLocation}，清洁度：${next.embodiment.vitals.hygiene}/100`,
      `当前穿搭：${next.embodiment.outfit.presetName}（${next.embodiment.outfit.items.map((i) => `${i.name}:已穿${i.wornMinutes}m/汗湿${i.wetness}`).join("，")}）`,
      `待办日程：${next.world.schedule.filter((s) => s.status === "pending").map((s) => `${s.title}@${s.location}`).join("；") || "无"}`
    ].join("\n");

    const parsed = await this.callJsonPass("offscreen_autonomy", systemPrompt, userPrompt, input.abortSignal);
    if (!parsed) {
      return next;
    }

    if (typeof parsed.currentLocation === "string" && parsed.currentLocation.trim()) {
      next.world.currentLocation = parsed.currentLocation.trim();
    }
    if (parsed.bathedAndCleaned === true) {
      next.embodiment.vitals.hygiene = 95;
      for (const item of next.embodiment.outfit.items) {
        item.wornMinutes = 0;
        item.wetness = 0;
        item.secretionStain = 0;
        item.odorIntensity = 0;
        item.odorNote = "刚洗净或换上的清新织物气息";
        item.comfort = 90;
      }
    }
    if (typeof parsed.changedOutfitPreset === "string" && parsed.changedOutfitPreset.trim()) {
      next.embodiment.outfit.presetName = parsed.changedOutfitPreset.trim();
    }
    if (typeof parsed.lastOffScreenSummary === "string" && parsed.lastOffScreenSummary.trim()) {
      next.world.lastOffScreenSummary = parsed.lastOffScreenSummary.trim();
      next.journal.push(statefulRpJournalEntrySchema.parse({
        id: nanoid(8),
        clockIso: next.clock.currentIso,
        category: "world",
        summary: `独处期间：${next.world.lastOffScreenSummary}`
      }));
    }
    for (const sched of next.world.schedule) {
      if (sched.status === "pending" && Date.parse(sched.endIso) <= Date.parse(next.clock.currentIso)) {
        sched.status = "completed";
      }
    }
    return next;
  }

  private async runEmbodimentSensoryPass(
    state: StatefulRpSessionState,
    input: StatefulRpPostTurnInput
  ): Promise<StatefulRpSessionState> {
    const next = structuredClone(state);
    const systemPrompt = [
      "你是沉浸状态角色扮演（stateful_rp）的【服饰物理与分部位感官维护器】。",
      "请专门根据各件衣物/丝袜/内衣/鞋靴的材质（material）、透气性（breathability）、贴身度（fit）、已穿戴时长（wornMinutes）、私密道具（intimateGear）穿戴时长、环境温度与活动类型，推理衣物物理状态与角色身体 6 个部位的细腻感受。",
      "推理重点：",
      "1. 丝袜/连裤袜、紧身靴鞋、低透气内衣在外出、步行或闷热环境下久穿（wornMinutes 较长）会积累汗湿（wetness）、黏腻不适（comfort 下降）与温热微酸或体香混合的气味（odorIntensity 与 odorNote）。",
      "2. 私密内衣或情趣道具（intimateGear）结合情欲唤醒度与摩擦，会产生分泌物痕迹（secretionStain）、局部摩擦充血、异物存在感与肌肉紧绷。",
      "3. 为身体 6 个部位（head_neck, chest, waist_belly, groin_hips, thighs_legs, feet）生成具体的体感描述（sensation）、外观痕迹（appearanceNote，如勒痕、潮红、汗津津）、气味描述（scentNote）、敏感度（sensitivity 0~100）和注意力显著度（salience 0~100，越难受或越刺激越高）。",
      "只输出严格 JSON：",
      JSON.stringify({
        itemUpdates: [
          {
            id: "衣物id",
            wetness: 0,
            secretionStain: 0,
            odorIntensity: 0,
            odorNote: "气味描述",
            wrinkles: 0,
            comfort: 80,
            conditionNote: "物理状态说明"
          }
        ],
        overallImpact: "全身穿戴与道具带来的综合感官总结（1-2句）",
        observableAppearance: ["外人可见的体态或生理线索，如耳根微红、双腿不自然并拢、额角细汗"],
        partSensations: {
          head_neck: { sensation: "", appearanceNote: "", scentNote: "", sensitivity: 20, salience: 10 },
          chest: { sensation: "", appearanceNote: "", scentNote: "", sensitivity: 35, salience: 15 },
          waist_belly: { sensation: "", appearanceNote: "", scentNote: "", sensitivity: 25, salience: 10 },
          groin_hips: { sensation: "", appearanceNote: "", scentNote: "", sensitivity: 50, salience: 25 },
          thighs_legs: { sensation: "", appearanceNote: "", scentNote: "", sensitivity: 35, salience: 20 },
          feet: { sensation: "", appearanceNote: "", scentNote: "", sensitivity: 30, salience: 20 }
        },
        intimateState: {
          lubrication: 10,
          muscleTension: 15,
          lingeringSimulation: "",
          secretionNote: ""
        }
      })
    ].join("\n");

    const userPrompt = [
      `当前时间与环境：${formatIsoToDisplayClock(next.clock.currentIso)}，地点：${next.world.currentLocation}（${next.world.locationTags.join("/")}），天气：${next.world.weather}，最近活动：${next.clock.lastActivityKind}`,
      `生理状态：体力${next.embodiment.vitals.stamina}，清洁度${next.embodiment.vitals.hygiene}，憋尿/便意${next.embodiment.vitals.bladder}，经期阶段：${next.embodiment.cycle.phase}(不适:${next.embodiment.cycle.symptomSeverity})，情欲唤醒：${next.mind.desire.arousal}`,
      `当前穿戴清单：${JSON.stringify(next.embodiment.outfit.items)}`,
      `私密配饰/道具：${JSON.stringify(next.embodiment.outfit.intimateGear)}`,
      `当前分部位感官：${JSON.stringify(next.embodiment.partSensations)}`,
      `本轮玩家输入：${input.userText}`,
      `本轮角色回复：${input.assistantText}`
    ].join("\n");

    const parsed = await this.callJsonPass("embodiment_sensory", systemPrompt, userPrompt, input.abortSignal);
    if (!parsed) {
      return next;
    }

    if (Array.isArray(parsed.itemUpdates)) {
      for (const rawUpdate of parsed.itemUpdates) {
        if (!isRecord(rawUpdate) || typeof rawUpdate.id !== "string") {
          continue;
        }
        const target = next.embodiment.outfit.items.find((item) => item.id === rawUpdate.id);
        if (!target) {
          continue;
        }
        if (typeof rawUpdate.wetness === "number") target.wetness = clamp(rawUpdate.wetness, 0, 100);
        if (typeof rawUpdate.secretionStain === "number") target.secretionStain = clamp(rawUpdate.secretionStain, 0, 100);
        if (typeof rawUpdate.odorIntensity === "number") target.odorIntensity = clamp(rawUpdate.odorIntensity, 0, 100);
        if (typeof rawUpdate.odorNote === "string") target.odorNote = rawUpdate.odorNote.trim();
        if (typeof rawUpdate.wrinkles === "number") target.wrinkles = clamp(rawUpdate.wrinkles, 0, 100);
        if (typeof rawUpdate.comfort === "number") target.comfort = clamp(rawUpdate.comfort, 0, 100);
        if (typeof rawUpdate.conditionNote === "string") target.conditionNote = rawUpdate.conditionNote.trim();
      }
    }

    if (typeof parsed.overallImpact === "string" && parsed.overallImpact.trim()) {
      next.embodiment.outfit.overallImpact = parsed.overallImpact.trim();
    }
    if (Array.isArray(parsed.observableAppearance)) {
      const obs = parsed.observableAppearance.map((v) => String(v ?? "").trim()).filter(Boolean);
      if (obs.length > 0) {
        next.embodiment.appearance.observable = obs;
      }
    }

    if (isRecord(parsed.partSensations)) {
      for (const key of statefulRpBodyPartKeys) {
        const patch = parsed.partSensations[key];
        if (!isRecord(patch)) {
          continue;
        }
        const target = next.embodiment.partSensations[key];
        if (typeof patch.sensation === "string") target.sensation = patch.sensation.trim();
        if (typeof patch.appearanceNote === "string") target.appearanceNote = patch.appearanceNote.trim();
        if (typeof patch.scentNote === "string") target.scentNote = patch.scentNote.trim();
        if (typeof patch.sensitivity === "number") target.sensitivity = clamp(patch.sensitivity, 0, 100);
        if (typeof patch.salience === "number") target.salience = clamp(patch.salience, 0, 100);
      }
    }

    if (isRecord(parsed.intimateState)) {
      const ip = parsed.intimateState;
      if (typeof ip.lubrication === "number") next.embodiment.intimateState.lubrication = clamp(ip.lubrication, 0, 100);
      if (typeof ip.muscleTension === "number") next.embodiment.intimateState.muscleTension = clamp(ip.muscleTension, 0, 100);
      if (typeof ip.lingeringSimulation === "string") next.embodiment.intimateState.lingeringSimulation = ip.lingeringSimulation.trim();
      if (typeof ip.secretionNote === "string") next.embodiment.intimateState.secretionNote = ip.secretionNote.trim();
    }

    return next;
  }

  private async runMindAndRelationPass(
    state: StatefulRpSessionState,
    input: StatefulRpPostTurnInput
  ): Promise<StatefulRpSessionState> {
    const next = structuredClone(state);
    const systemPrompt = [
      "你是沉浸状态角色扮演（stateful_rp）的【心理转化与关系余韵维护器】。",
      "请结合角色当前的分部位身体感受（partSensations）、穿戴综合体感（overallImpact）、私密生理状态以及刚刚的对话互动，更新角色的表里情绪反差（surfaceVsInner）、侵入性杂念（intrusiveThoughts）、欲望羞耻指标（desire）、1~2 个具体的短期微意图（intentions）以及关系张力。",
      "推理重点：",
      "1. 身体上的黏腻汗湿、丝袜/内衣气味、私密道具刺激或憋尿不适，在公共场合或喜欢的人面前会转化为强烈的羞耻感（shame）、表面强装镇定与内心慌乱的反差（surfaceVsInner.tension）以及侵入性杂念（如担心身上的味道被闻到、想找借口去洗手间整理）。",
      "2. 短期微意图（intentions）应当是角色接下来 1~3 回合内想主动做的具体小事（例如：'找借口去卫生间擦拭大腿内侧并调整丝袜'、'把话题引开掩饰耳根发烫'）。",
      "只输出严格 JSON：",
      JSON.stringify({
        emotion: {
          primary: "主情绪",
          secondary: "副情绪",
          valence: 15,
          arousal: 35,
          selfControl: 70
        },
        surfaceVsInner: {
          surfaceDemeanor: "外在表现出的态度与神情",
          innerMonologue: "内心真实的羞耻/渴望/盘算独白",
          tension: 45
        },
        desire: {
          arousal: 25,
          longing: 30,
          shame: 40,
          frustration: 20,
          focus: "当前欲望或羞耻焦点"
        },
        intrusiveThoughts: ["侵入性杂念1", "侵入性杂念2"],
        intentions: [
          {
            goal: "具体短期微意图",
            reason: "产生该意图的身体或心理原因",
            priority: 4
          }
        ],
        relationshipTension: {
          unresolvedFriction: 0,
          romanticTension: 25,
          recentAfterglow: "近期互动留下的余韵描述"
        }
      })
    ].join("\n");

    const salientPartsSummary = statefulRpBodyPartKeys
      .map((key) => `${key}:体感=${next.embodiment.partSensations[key].sensation}(气味:${next.embodiment.partSensations[key].scentNote},显著度:${next.embodiment.partSensations[key].salience})`)
      .join("；");

    const userPrompt = [
      `角色名：${input.personaName}`,
      `当前地点：${next.world.currentLocation}（在场：${next.world.presentNpcs.join("、") || "仅双方"}）`,
      `穿戴综合体感：${next.embodiment.outfit.overallImpact}`,
      `各部位体感：${salientPartsSummary}`,
      `私密生理状态：润滑=${next.embodiment.intimateState.lubrication}，紧绷=${next.embodiment.intimateState.muscleTension}，余韵=${next.embodiment.intimateState.lingeringSimulation}，痕迹=${next.embodiment.intimateState.secretionNote}`,
      `当前心理与关系：${JSON.stringify({ mind: next.mind, relationshipTension: next.relationship.tension, promises: next.relationship.promises })}`,
      `本轮玩家输入：${input.userText}`,
      `本轮角色回复：${input.assistantText}`
    ].join("\n");

    const parsed = await this.callJsonPass("mind_and_relation", systemPrompt, userPrompt, input.abortSignal);
    if (!parsed) {
      return next;
    }

    if (isRecord(parsed.emotion)) {
      const ep = parsed.emotion;
      if (typeof ep.primary === "string" && ep.primary.trim()) next.mind.emotion.primary = ep.primary.trim();
      if (typeof ep.secondary === "string") next.mind.emotion.secondary = ep.secondary.trim();
      if (typeof ep.valence === "number") next.mind.emotion.valence = clamp(ep.valence, -100, 100);
      if (typeof ep.arousal === "number") next.mind.emotion.arousal = clamp(ep.arousal, 0, 100);
      if (typeof ep.selfControl === "number") next.mind.emotion.selfControl = clamp(ep.selfControl, 0, 100);
    }

    if (isRecord(parsed.surfaceVsInner)) {
      const sp = parsed.surfaceVsInner;
      if (typeof sp.surfaceDemeanor === "string" && sp.surfaceDemeanor.trim()) {
        next.mind.surfaceVsInner.surfaceDemeanor = sp.surfaceDemeanor.trim();
      }
      if (typeof sp.innerMonologue === "string" && sp.innerMonologue.trim()) {
        next.mind.surfaceVsInner.innerMonologue = sp.innerMonologue.trim();
      }
      if (typeof sp.tension === "number") {
        next.mind.surfaceVsInner.tension = clamp(sp.tension, 0, 100);
      }
    }

    if (isRecord(parsed.desire)) {
      const dp = parsed.desire;
      if (typeof dp.arousal === "number") next.mind.desire.arousal = clamp(dp.arousal, 0, 100);
      if (typeof dp.longing === "number") next.mind.desire.longing = clamp(dp.longing, 0, 100);
      if (typeof dp.shame === "number") next.mind.desire.shame = clamp(dp.shame, 0, 100);
      if (typeof dp.frustration === "number") next.mind.desire.frustration = clamp(dp.frustration, 0, 100);
      if (typeof dp.focus === "string") next.mind.desire.focus = dp.focus.trim();
    }

    if (Array.isArray(parsed.intrusiveThoughts)) {
      next.mind.intrusiveThoughts = parsed.intrusiveThoughts
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .slice(0, 6);
    }

    if (Array.isArray(parsed.intentions)) {
      const updatedIntentions = parsed.intentions
        .filter(isRecord)
        .map((item) => ({
          id: nanoid(6),
          goal: String(item.goal ?? "").trim(),
          reason: String(item.reason ?? "").trim(),
          priority: clamp(Number(item.priority ?? 3), 1, 5),
          status: "active" as const
        }))
        .filter((item) => Boolean(item.goal))
        .slice(0, 3);
      if (updatedIntentions.length > 0) {
        next.mind.intentions = updatedIntentions;
      }
    }

    if (isRecord(parsed.relationshipTension)) {
      const rt = parsed.relationshipTension;
      if (typeof rt.unresolvedFriction === "number") {
        next.relationship.tension.unresolvedFriction = clamp(rt.unresolvedFriction, 0, 100);
      }
      if (typeof rt.romanticTension === "number") {
        next.relationship.tension.romanticTension = clamp(rt.romanticTension, 0, 100);
      }
      if (typeof rt.recentAfterglow === "string") {
        next.relationship.tension.recentAfterglow = rt.recentAfterglow.trim();
      }
    }

    return next;
  }
}

export function buildOutfitSignature(state: StatefulRpSessionState): string {
  const itemsSig = state.embodiment.outfit.items
    .map((item) => `${item.id}:${item.slot}:${item.name}:${item.displacement}`)
    .join("|");
  const gearSig = state.embodiment.outfit.intimateGear
    .map((gear) => `${gear.id}:${gear.name}:${gear.intensity}`)
    .join("|");
  return `${state.embodiment.outfit.presetName}::${itemsSig}::${gearSig}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFirstJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

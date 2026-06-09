# Scenario Host 自动状态抽取 TODO

## 目标

`scenario_host` 模式不应继续使用普通用户记忆抽取器。普通抽取器沉淀的是用户长期事实和会话事实，而 `scenario_host` 需要维护的是当前会话内的剧情世界状态，包括剧情日志、实体、关系、目标、背包和少量世界设定。

目标是新增一个会话级 Scenario 抽取器，用低成本异步流程在每轮回复后补充结构化状态，减少主模型必须主动调用状态工具的负担，同时避免把剧情内容污染到普通用户记忆。

## 当前状态

- `scenario_host` prompt 已跳过普通 user/session 记忆注入和语义检索。
- `scenario_host` 回复完成后应跳过普通 `ContextExtractionQueue`。
- Scenario runtime prompt 使用当前回合激活切片，而不是全量注入 Lore、实体、关系和日志。
- 自动 Scenario 抽取器尚未实现。

## 非目标

- 不把 Scenario 剧情事实写入 `contextStore`。
- 不复用普通记忆抽取器的 prompt、schema 或 apply 逻辑。
- 第一版不自动大规模生成 Lore；Lore 更适合后续做低频整理。
- 不让抽取器替代主模型当场主持。主模型仍负责当前回复，抽取器只负责回合后的结构化补漏。

## 推荐结构

```text
generationExecutor
  -> TurnExtractionDispatcher
      -> ContextExtractionQueue      // 普通模式，per-user，写 contextStore
      -> ScenarioExtractionQueue     // scenario_host，per-session，写 scenarioHostStateStore
```

建议新增模块：

```text
src/app/generation/turnExtractionDispatcher.ts
src/app/generation/turnExtractionTypes.ts

src/modes/scenarioHost/extraction/scenarioExtractionQueue.ts
src/modes/scenarioHost/extraction/scenarioExtractionService.ts
src/modes/scenarioHost/extraction/scenarioExtractionPrompt.ts
src/modes/scenarioHost/extraction/scenarioExtractionGate.ts
src/modes/scenarioHost/extraction/scenarioExtractionApply.ts
src/modes/scenarioHost/extraction/scenarioExtractionTypes.ts
src/modes/scenarioHost/runtimeContextSelection.ts
```

`runtimeContextSelection.ts` 应从 prompt builder 中抽出 Scenario 上下文筛选逻辑，让 prompt 注入和抽取器共享同一套相关 Lore、实体、关系、日志选择规则。

## 回合观察输入

Scenario 抽取器应按 `sessionId` 聚合，不按 `userId` 聚合。

```ts
interface FinalizedTurnObservation {
  sessionId: string;
  modeId: "scenario_host";
  chatType: "private" | "group";
  completedAt: number;
  batchMessages: Array<{
    userId: string;
    senderName: string;
    text: string;
    receivedAt: number;
    scenarioInputKind?: "action" | "dialogue" | "ooc";
  }>;
  assistantText: string;
  toolEvents: Array<{
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    resultText: string;
    success: boolean;
  }>;
}
```

抽取 prompt 的输入范围：

- 本轮所有玩家消息，并保留 Scenario 输入协议解析结果。
- 本轮 assistant 最终回复。
- 本轮 Scenario 工具调用与结果。
- `scenarioStateBefore` 精简切片。
- `scenarioStateAfter` 精简切片。
- 最近 1-3 个待抽取 turns。
- 最近 3-5 条 journal。
- 与本轮相关的实体、关系和 Lore 切片。

不要传完整历史，也不要传普通用户记忆。

## 输出操作

第一版建议只启用 `append_journal`、`upsert_npc`、`upsert_entity`、`upsert_relation`，其他操作先保留 schema 设计但默认关闭。NPC 是独立角色数据，不再作为 `entity.kind = "npc"` 写入。

```ts
type ScenarioExtractionOperation =
  | { op: "noop"; reason: string }
  | { op: "append_journal"; title: string; summary: string; entityRefs?: string[]; tags?: string[]; confidence: number; evidence: string }
  | { op: "upsert_npc"; name: string; aliases?: string[]; basicInfo: string; characterDescription: string; wornItems: Array<{ name: string; wearPosition: string; description: string }>; heldItems: Array<{ name: string; description: string; quantity?: number }>; statusDescription?: string; locationRef?: string | null; tags?: string[]; confidence: number; evidence: string }
  | { op: "upsert_entity"; kind: "location" | "item" | "organization" | "faction" | "other"; name: string; aliases?: string[]; summary?: string; status?: string; locationRef?: string | null; tags?: string[]; confidence: number; evidence: string }
  | { op: "upsert_relation"; sourceRef: string; targetRef: string; kind: string; summary: string; strength?: number; confidence: number; evidence: string }
  | { op: "update_objective"; objectiveRef?: string; title?: string; status?: "active" | "completed" | "failed"; summary?: string; confidence: number; evidence: string }
  | { op: "inventory_delta"; ownerRef: string; item: string; delta: number; confidence: number; evidence: string };
```

## Apply 规则

- 低于 `minConfidence` 的 operation 直接忽略。
- `evidence` 必须来自本轮用户消息、assistant 回复或工具结果。
- 玩家“想做、打算做、准备做”的内容不能当成已发生事实。
- `#` 场外指令不能写入剧情事实。
- 纯氛围描写、未确认猜测、比喻不写入状态。
- 本轮主模型已经调用 `append_journal_entry` 时，默认不再自动追加 journal。
- 同一 `turnIndex` 的近似 journal 标题或摘要已存在时跳过。
- entity 通过 `id/name/aliases` 解析已有条目，找不到再创建。
- relation 通过 `sourceId + targetId + kind` upsert。
- 自动写入必须只做局部 patch，不整体覆写 Scenario state。

## 成本控制

`scenarioExtractionGate.ts` 应先规则判断，尽量避免无意义 LLM 调用。

跳过条件：

- assistant 回复很短且没有剧情推进。
- 本轮只有场外问题、配置请求或无剧情内容。
- 没有玩家动作、地点、实体、物品、目标、关系或线索迹象。
- 本轮 Scenario 工具已经完整维护状态。
- pending turns 未达到 batch 阈值且未超过最大延迟。

降低 token：

- per-session 批处理，不按 userId 重复跑。
- 只传 state slice，不传完整 state。
- 只传最近 1-3 turns。
- 使用 summarizer/cheap model。
- 输出 JSON operations，不输出自然语言分析。
- Lore 整理改成低频触发，例如场景切换或每 N 轮。

## 配置建议

不要挂在 `context.extraction` 下，建议新增：

```yaml
modes:
  scenarioHost:
    extraction:
      enabled: true
      debounceMs: 5000
      maxDelayMs: 30000
      maxTurnsPerBatch: 3
      timeoutMs: 30000
      minConfidence: 0.75
      enableThinking: false
      journal:
        enabled: true
      npcs:
        enabled: true
        maxOpsPerBatch: 4
      entities:
        enabled: true
        maxOpsPerBatch: 4
      relations:
        enabled: true
        maxOpsPerBatch: 4
      inventory:
        enabled: false
      objectives:
        enabled: false
      lore:
        enabled: false
```

## 实现顺序

1. 抽出 `TurnExtractionDispatcher`，普通模式继续走 `ContextExtractionQueue`，`scenario_host` 不进入普通记忆抽取。
2. 新增 `ScenarioExtractionQueue`，按 session 防抖和批处理。
3. 新增 `ScenarioExtractionService`，第一版只实现 `append_journal`。
4. 在 generation executor 中收集本轮 Scenario 工具事件，供抽取器去重和跳过。
5. 实现 entity/relation operations。
6. 按需启用 objective/inventory operations。
7. 后续再做低频 Lore 整理器。

## 测试清单

- `scenario_host` 不 enqueue 普通 context extraction。
- 普通模式仍按 userId enqueue context extraction。
- `scenario_host` 多用户消息只 enqueue 一次 per-session extraction。
- 本轮已调用 `append_journal_entry` 时不重复追加 journal。
- 低置信度 operation 不落库。
- 场外指令不写入 state。
- 玩家意图不当成已发生事件。
- entity 按 name/alias upsert，不重复创建。
- relation 按 source/target/kind upsert。
- session reset 会 cancel scenario pending extraction。

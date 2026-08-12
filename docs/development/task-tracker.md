# TaskTracker

TaskTracker 是 session 级的轻量任务状态记录，用来让多轮工具任务在压缩、后台资源和用户插话之间保持最小可恢复上下文。它不是完整 artifact store，也不做 task DAG 或向量检索。

## 设计边界

- 工具结果的 canonical / initial / replay 投影仍由 `toolResultProjection`、`ToolObservation`、provider replay 和 `providerWorkingMessageBudget` 负责。
- TaskTracker 只保存当前任务状态和少量 parked task 摘要。
- 不对每个工具结果调用 LLM 总结；状态更新只用保守规则。
- prompt 只在存在相关任务状态时条件注入，且只展示短状态。

## 数据结构

session 持久化字段为 `taskTrackerJson`，内存结构为：

```json
{
  "version": 1,
  "primary": null,
  "parked": []
}
```

`primary` 保存当前任务的目标、状态、短 done/next/blockers 和最多 12 个关键工具引用。`parked` 最多 2 个，只保存 taskId、status、objective、summary、最多 3 个关键工具引用和更新时间。

## 生命周期

普通聊天不会主动创建任务。只有任务型工具实际发生时，`observeToolResult` 才会创建 `primary`，避免闲聊误入任务状态。

用户批次会在 prompt 构建前先经过 `observeUserBatch` 的确定性规则兜底：

- 明确取消在没有 running resource 时进入 `canceled`。
- 明确取消且存在或无法确认 running resource 时进入 `waiting_user`，要求确认是否停止后台资源；不会自动 kill/stop。
- “算了”“先这样”等模糊表达进入 `cancel_confirming`。
- “继续/接着做/恢复刚才的任务”会恢复 suspended、cancel_confirming 或 ready_to_close。

如果 turnPlanner 启用，TaskTracker 不新增 LLM 调用，而是向现有 turnPlanner 追加一个极短 `task_context`，由 planner 多输出一行 `task_intent`：

```text
task_intent: <kind>|<target_task_id_or_none>|<low|medium|high>
```

`task_context` 只包含 primary 的 taskId/status/objective/最后一条 next 或 blocker，以及最多 2 个 parked 摘要；不会包含完整工具 refs。planner 只负责语义判别，代码仍负责状态转移和安全边界。低置信度、unknown 或 none 不改变任务状态。

工具结果会在 transcript append 成功后观察：

- terminal running 进入 `waiting_tool`。
- 失败或非零退出码只记录 blocker，不直接 completed。
- 搜索只记录短摘要和数量，不保存完整 results 到任务状态。
- 工具成功不会直接 completed。

最终 assistant 回复只会把可收尾任务转为 `ready_to_close`；用户确认后才进入 `completed`。

## Parked Tasks

当旧 `primary` 是 `waiting_tool`、`suspended` 或 `ready_to_close`，而新的工具型任务开始且工具结果不匹配旧任务的 toolCallId/resource 时，旧任务会被压缩成 parked task，新任务成为 primary。

parked task 不是 DAG。恢复只通过两类保守触发：

- 用户消息明确包含 parked task 的 taskId 或完整 objective。
- 后台工具回调的 toolCallId/resource 命中 parked task 的关键工具引用。

恢复时当前 primary 会被压成 parked，以保持一个 primary 焦点。

## Prompt 注入

无 primary 且无 parked 时，不注入 TaskTracker section。

active、waiting_tool、waiting_user、cancel_confirming 会注入 `task_focus`、`active_task_state`。其中 active、waiting_tool、waiting_user 在激活工具集匹配时通过 `tool_playbooks` 注入多步任务操作规范；cancel_confirming 只保留取消确认焦点，不继续鼓励工具推进。`ready_to_close` 只显示短状态；`suspended` 只显示暂停提示；completed/canceled 不显示 primary 状态。

parked tasks 只在 `active_task_state` 中显示一行摘要，不展开 done/next/blockers/refs，避免长期污染普通聊天 prompt。

## 已知限制

- turnPlanner 关闭或低置信度时，用户恢复 parked task 仍依赖精确 taskId 或完整 objective 匹配。

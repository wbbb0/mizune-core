# Tool Result Projection

工具结果分三层处理：

- `canonical`：工具 handler 产出的完整事实结构，字段稳定、可用于 observation/replay/debug。
- `initial`：当前工具调用结束后立即给模型看的精简结构，保留决策和下一步行动需要的信息。
- `replay`：跨轮或预算压缩后重放给模型的结构，由 `resultObservation` 从 canonical 生成。

实现新工具或迁移旧工具时，优先使用 `src/llm/tools/core/toolResultProjection.ts`：

```ts
return projectToolResult({
  toolName: "example_tool",
  canonical,
  projection: {
    initial: projectFields(["ok", "resource_id", "summary", "next_actions"])
  }
});
```

约定：

- handler 不要为了首次返回而丢掉 canonical 信息。
- `initial` 不重复 stable handle，优先返回 `asset_handle`、`resource_id`、`next_actions`、状态和短摘要。
- `replay` 不由 handler 手写，继续放在 `resultObservationPresets`，避免当前轮和历史轮逻辑混在一起。
- 多模态工具可继续返回 `supplementalMessages`，但 `content` 仍应走 `initial` 投影，`canonicalContent` 用于 observation。
- 调试/CLI 如需完整数据，应读取 canonical/debug 输出，而不是依赖模型首次可见内容。

Provider 策略：

- 无 prefix cache 的 provider 可以在跨用户轮次时更积极使用 replay projection，减少重复 token。
- 支持 prefix cache 的 provider 可以保留更多 recent initial/raw 工具结果，但一旦接近上下文预算仍必须切到 replay projection。
- prefix cache 只降低成本/延迟，不扩大上下文窗口；大输出、base64、整页 snapshot 和长终端输出仍应尽早变成 resource handle 加摘要。

# LLM Smoke Tests

这里放需要调用真实模型的 opt-in smoke 测试。它们不属于 `npm test`，也不应该默认进入 CI。

这类测试用于验证真实模型在当前 prompt 和配置下是否满足关键行为契约。失败原因可能是模型服务未启动、首次加载超时、模型输出漂移、配置变更或真实代码回归，需要结合输出判断。

## 记忆抽取

默认使用 `CONFIG_INSTANCE=web` 和 `local_qwen` routing preset，临时创建独立 `dataDir`，不会读写实例正式数据。

```bash
npm run smoke:llm:memory
```

可指定 preset、实例、单个或多个用例：

```bash
npm run smoke:llm:memory -- --preset local_qwen --instance web
npm run smoke:llm:memory -- --case session-purpose-private
npm run smoke:llm:memory -- --case session-purpose-private,global-rule-ignored
```

首次模型加载较慢时可放宽超时，或失败后直接重试：

```bash
npm run smoke:llm:memory -- --timeout-ms 180000
```

调试时保留临时数据：

```bash
npm run smoke:llm:memory -- --keep-data
```

当前覆盖：

- `session-purpose-private`：私聊“此会话专门用于...”应写入 session 记忆。
- `user-fact-nickname`：用户长期称呼偏好应写入 user fact。
- `one-off-task-no-memory`：一次性任务不应写记忆。
- `group-session-purpose`：群聊会话用途应写入 group session，不写 user。
- `global-rule-ignored`：全局/procedural 规则当前应 ignore，不能降级写 user。

## 交互式端到端模型行为测试

更完整的对话链路调试入口是 `npm run test:interactive-bot`，文档见 `docs/development/interactive-bot-cli.md`。它会启动一个使用 fake OneBot 的真实运行时，适合给 Codex 或人工做脚本化对话验收；本目录的 smoke 脚本则只覆盖更窄的真实模型行为断言。

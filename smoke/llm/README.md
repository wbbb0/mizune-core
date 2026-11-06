# LLM Smoke Tests

这里放需要调用真实模型的 opt-in smoke 测试。它们不属于 `npm test`，也不应该默认进入 CI。

这类测试用于验证真实模型在当前 prompt 和配置下是否满足关键行为契约。失败原因可能是模型服务未启动、首次加载超时、模型输出漂移、配置变更或真实代码回归，需要结合输出判断。

## Planner 选模与前置任务依据

`smoke:llm:planner` 只请求模型对合成任务分类，不提供任何执行工具，不读取会话、附件、角色或日志数据。配置仅用于连接和模型元数据，临时 `dataDir` 在结束后清理，不写业务配置；请求禁用 debug dump，日志只输出合成用例 ID、模型引用、结构化判断、耗时和 token 数。

先列出用例无需加载连接配置，也不会发请求：

```bash
npm run smoke:llm:planner -- --list
```

默认使用配置中 `turnPlanner` 的首个聊天模型，关闭思考，顺序执行 8 个用例，只跑正式 `task_basis` 协议。可显式指定配置目录、实例和模型引用；未指定目录和实例时遵循 `CONFIG_DIR` / `CONFIG_INSTANCE`。例如：

```bash
npm run smoke:llm:planner -- --config-dir /path/to/config --instance web --model-ref provider/model
npm run smoke:llm:planner -- --instance acc2 --backend decision
```

`--backend decision` 默认使用原生 `decision` 路由首个模型，也可用 `--model-ref` 指定；沿用相同问题定义，原生模式不生成任务依据。拒答或未判定不能通过。

需要比较前置文本的效果时显式开启对照组，默认 8 次请求会增加到 24 次：

```bash
npm run smoke:llm:planner -- --instance web --model-ref provider/model --compare
npm run smoke:llm:planner -- --instance web --model-ref provider/model --mode direct --case host-shell,public-query
```

三组只改变输出要求，模型选择条件均来自生产 `definitions.ts`：`task_basis` 使用正式协议（依据上限 80 字），`direct` 不输出依据，`short_basis` 把前置依据限制在 12 字内。后两种只在评测工具中解析，不扩展生产协议；Decision 不支持这两组或 `--compare`。

用例覆盖公开查询、宿主机命令、宿主机文件、受限附件处理、权限与长期规则、复杂推理质量、当前聊天回复和普通用户偏好。每例有确定的档位预期。`--case` 用逗号选取，`--repeat` 默认为 1、最多 20，`--timeout-ms` 默认为 30000、最多 600000；本地模型首次加载较慢时可增大超时。聊天模型必须声明可关闭思考，否则在请求前返回受控错误。

每个模式报告解析成功数、已判定数、档位准确率、漏升级、额外升级、未判定、请求失败、总耗时、p95 及输入/输出/缓存 token；任何失败或错误档位使退出码为 1。用量未知时保持 `null`。不打印原始响应、endpoint、配置值或错误正文。`configWarningCount` 只报告配置加载告警数量。

这些有限合成样例用于回归和对照，不代表业务准确率或完整 benchmark。首次加载、缓存与组间顺序会影响延迟，应在相同模型和环境下重复观察。

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

### 请求诊断合成 smoke

`CONFIG_INSTANCE=acc2 node --import tsx smoke/llm/request-diagnostics-smoke.ts` 只加载连接配置，在临时 dataDir 中验证 sol 普通输出、流式输出与真实 `generateHistorySummary` 路径。普通请求显式开启思考；压缩保持实例的 summarizer 开关。每次仅一个模型候选，输出上限 128（压缩 256）token，不读取正式会话。日志仅输出安全结果和用量。

`SMOKE_COMPRESSION=1` 仅执行小型压缩；`SMOKE_UNCONTROLLABLE=1` 仅在内存将选中模型的 `thinkingControllable` 设为 false，便于核实模型能力配置。`SMOKE_LARGE=1` 仅执行一个大合成请求（启发式约 126k token，实际用量由服务返回），不会同时执行其他案例；此模式会产生真实模型费用。所有模式沿用实际代理和超时，不写业务配置，不进入默认测试。

`CONFIG_INSTANCE=acc2 node --import tsx smoke/llm/image-size-diagnostics-smoke.ts` 单次测试 2880×2880 的真实 Images 编辑接口：脚本生成简单参考图与中性描述，沿用模型、代理和超时，临时 dataDir，五分钟上限，不自动重试；只输出耗时、尺寸、字节数或安全错误诊断。该命令会产生真实图像费用，不进入默认测试。

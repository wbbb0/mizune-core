# Minecraft Actor 资源与决策循环

状态：已实现父项目接口与模拟运行时契约；真实 NeoForge transport 和隔离 Script Worker 尚未接入。

## 边界

Minecraft Actor 是跨会话可见的系统资源，不是聊天 session，也不把游戏 tick、内部计划或脚本日志写进普通聊天历史。

- `mizune-mc-runtime` 负责结构化感知、动作租约、确定性行为、任务队列、战斗、聊天、自治策略及 Python 程序生命周期。
- `MinecraftActorClient` 是父项目使用的版本化协议边界，所有响应均做严格运行时校验。
- `MinecraftDecisionRunner` 负责一次有界模型唤起，只做读取、一次控制提交和持久认知更新。
- `MinecraftActorResourceManager` 负责持久资源、client 生命周期、串行/打断循环、显著事件游标与所属会话通知。
- OneBot/Web 会话只通过资源工具或内部事件与 Actor 交互，不直接拥有 Minecraft transport。

## 决策输入与输出

一次决策固定只发送三条消息：

1. 一个稳定的中文 system prompt。
2. 一个包含 Actor ID、当前目标和持久状态文本的结构化 user message。
3. 一个包含本次唤起原因、时间和必要详情的结构化 user message。

Decision Runner 固定关闭思考覆盖，并优先使用 provider 的原生无思考端点。模型可以并行调用只读工具；控制、结束和程序部署工具必须独占工具轮次。整个唤起跨多个工具轮次最多接受一次成功控制提交，随后只能读取结果或调用 `minecraft_finish_decision`。

`minecraft_finish_decision` 返回：

- 本次决策摘要；
- 完整的更新后持久状态文本；
- 更新后的当前目标；
- 可选的下次唤起提示。

普通 assistant 文本没有控制效果，也不能替代结束工具。

## 可编程行为部署

程序修改采用两阶段接口：

1. `program.validate` 对完整 Python 源码、API 版本、capability、source hash、Actor revision 和 AST 约束做预检，并生成短期 draft。
2. `program.activate` 以 draft ID、Actor revision 和幂等键原子激活版本。

SHA-256 由父项目根据完整源码计算，不要求模型生成。静态 AST 校验只负责快速反馈，不是安全沙箱。当前模拟运行时只验证和激活程序版本，不执行模型源码；接真实客户端前必须补独立 CPython worker、OS 级网络/文件/进程隔离和带预算的 host API。

## 持久资源

`minecraft_actor` 资源持久化以下恢复状态：

- Actor ID、transport 类型、无密钥端点和 protocol version；
- 所属会话 ID；
- 持久状态、当前目标和决策模型列表；
- 自治策略修改和程序部署权限；
- 最后消费的 runtime event sequence。

启动清理只删除浏览器页面与 Shell session 等临时句柄，保留 Minecraft Actor。资源 schema v2 会原位迁移 v1 的浏览器和 Shell 数据。认证 token、账号凭据和 Microsoft 登录信息不得写入该表，应由独立 credential reference/transport 配置提供。

## 唤起、打断与通知

每个资源只有一个运行中的模型决策和一个有界 pending 槽位：

- 普通事件在当前决策后串行处理；
- 更高优先级或显式 `interruptCurrent` 的事件会取消当前模型请求；
- pending 槽位只保留优先级更高或同级更新的事件，被替代的调用方会收到 `superseded`；
- Actor 状态写入经过逐资源串行化，事件游标与决策完成不会互相覆盖。

高优先级/critical 游戏事件会通过 `MinecraftActorOwnerNotificationSink` 转成 `minecraft_actor_attention` 内部触发器，进入所属 OneBot/Web 会话的 inline trigger 队列。Minecraft 服务因此不直接依赖 OneBot；实际装配只需要把现有 session-work dispatcher 包装成通知 sink。

## 当前验证

- 子模块模拟运行时覆盖移动、跟随、拾取、实体交互、任务、统一聊天、战斗、显式空闲自治、revision/幂等/ref 和程序生命周期。
- 父项目覆盖严格协议解析、决策工具循环、单次控制提交、程序两阶段部署、资源 SQLite 迁移/恢复、打断调度、显著事件消费及 owner 内部通知。
- 默认回归不调用真实模型；真实 DeepSeek 行为继续放在 opt-in smoke 中验证，避免模型服务状态影响普通测试。

## 下一落地点

1. 实现带 request ID、取消和重连的 Unix socket / loopback transport，并让 Python runtime daemon 提供同一 v1 RPC。
2. 提供 app config 与 owner-only 创建/关闭接口，装配 `MinecraftActorResourceManager` 和内部通知 sink。
3. 增加 Actor 工具集，使所有会话可读取资源，只有 owner/operator 能修改连接、权限和程序；控制操作仍受资源策略约束。
4. 接独立 Script Worker 后再把 active program 变为可执行逻辑；在此之前继续以确定性内建行为作为可玩能力。
5. 最后接 NeoForge Bridge/Baritone，并用离线镜像服做 canary；真实服测试不进入默认单元回归。

# Minecraft Actor 资源与独立决策循环

状态：父项目的持久 Actor 控制面、独立模型循环、动态服务器绑定、受管进程 supervisor、真实 NeoForge Bridge、首个真实聊天行为、模拟 Runtime 契约与 WebUI 工作台已实现；移动/交互/战斗和隔离 Python Worker 尚未接入。

## 系统边界

Minecraft Actor 是跨会话可见的持久系统资源，不是聊天 session。游戏 tick、内部计划、结构化感知和脚本日志不进入普通聊天历史。

- 主 Bot 只拥有 `delegate/list/request/status/interrupt/close` 六个高层工具。`delegate` 原子执行“按服务器创建或复用资源 + 写入首条自然语言任务”。
- `MinecraftActorControlStore` 保存 owner principal、revision、FIFO mailbox、请求、决策与事件日志。
- `MinecraftDecisionRunner` 在私有工具上下文中使用只读观察、确定性行为、任务、自治和程序校验接口。主 Bot 无法直接调用这些接口。
- `MinecraftActorResourceManager` 负责 mailbox 调度、模型打断、Runtime client、显著事件摄取和 owner 通知。
- `MinecraftActorClient` 是父项目与模拟 Runtime、真实 NeoForge Runtime 共用的版本化 RPC 边界。
- WebUI 只消费 Actor read model 和持久 SSE 事件，不读取 socket、模型引用或 daemon 内部对象。

一次 owner 委派先以幂等键原子写入逻辑资源、服务器 binding 与持久 FIFO mailbox，立即返回 resource/request ID；后台 provisioner 准备身体。Runtime ready 前 mailbox 保持 paused，不调用模型也不累计重试；ready 后独立循环领取执行。应用正常停机导致的模型中断会把 wake 重新入队，手动 interrupt 和永久 close 才会形成终态。

## 决策调用契约

每次模型唤起固定包含三条消息：

1. 一个稳定的中文 system prompt。
2. 一个包含 Actor ID、当前目标和持久状态文本的结构化 user message。
3. 一个描述本次唤起原因和必要详情的结构化 user message。

Decision Runner 默认关闭思考覆盖，并优先使用运行模板的无思考模式。一次唤起可以多轮调用只读工具，但最多接受一次成功控制提交。控制调用、程序部署和结束工具必须独占一个工具轮次；普通 assistant 文本没有控制效果，也不能代替 `minecraft_finish_decision`。

结束工具提交决策摘要、完整更新后的持久状态、当前目标和可选的下次唤起提示。决策 ID、控制幂等键和 Runtime snapshot 共同用于崩溃后的对账，避免模型重试重复产生远端副作用。

## 持久状态与恢复

SQLite schema v5 的 canonical 状态包括：

- 通用 `runtime_resources` 与 Minecraft recovery state；
- `minecraft_actor_control_state`：owner principal、revision、loop phase 与当前决策；
- `minecraft_actor_requests`：owner 委派及其终态；
- `minecraft_actor_wake_mailbox`：按插入顺序领取的持久 wake；
- `minecraft_actor_decisions`：每次模型尝试、重试和结果；
- `minecraft_actor_events`：全局单调 event ID 的资源事件日志。
- `minecraft_actor_bindings`：规范化服务器、身份租约、模板指纹、desired state 与 provisioning 状态。
- `minecraft_runtime_incarnations`：每次受管 daemon/client 进程实例及其可验证启动身份。
- `minecraft_actor_delegations`：自然语言 delegate 的原子幂等收据。

首次 delegate 时资源、binding、control state、首条 request/wake 与幂等收据在同一事务内提交。`serverKey + identityRef` 对 open binding 有数据库唯一约束，不能依赖进程内扫描避免重复登录。启动会修复历史半状态，并把 active Actor 的未完成决策恢复为可重试 wake；closed Actor 不参与恢复。revision 冲突返回明确的 409，request 的幂等键重放必须保持参数指纹一致。

本结构不保留旧固定 endpoint Actor 的兼容层；schema v5 迁移会删除没有动态 binding 的旧 Actor 资源，浏览器和 Shell 资源不受影响。

Runtime 的命令结果、checkpoint 和事件游标由子模块 daemon 使用独立 SQLite 持久化。父项目与 Runtime 同时重启时仍复用命令幂等键，并以 snapshot 为最终状态依据。

## 唤起、打断与安全

普通 owner 请求进入 FIFO；高优先级游戏事件可以打断正在运行的模型决策。高频 telemetry 在进入模型前聚合，只有聊天呼叫、危险、连接变化、行为/任务完成、持续失败等显著事件产生 wake。

三个动作必须保持不同语义：

- `interrupt`：只打断当前模型决策，不等价于让游戏身体立即停手。
- `emergency stop`：未来独立的运维安全 RPC；在实现前 UI 明确禁用。
- `close`：永久关闭父项目 Actor 和未完成 mailbox；transport close 只释放本地连接。

父连接消失后，Runtime 控制租约到期会取消尚未产生外部副作用的活动行为和排队任务、关闭自治并进入安全态。已经投递到外部客户端但尚未确认结果的行为必须收敛为“副作用未知”的失败终态，不能误报取消。持久 close 成功是管理 API 的成功边界；本地 transport 清理失败只记录并后台重试，不能把已经提交的永久关闭翻转成 HTTP 失败。

## SSE 与 WebUI read model

Internal API 提供 Actor 列表、详情、owner request、interrupt、close 和 SSE stream。mutation 要求 Same-Origin、expected revision；request 还必须携带 `Idempotency-Key`。

SSE 使用 SQLite event ID：

- 首次连接发送 snapshot；有效 cursor 发送 resume 与精确 replay；过旧或越界 cursor 发送 reset。
- 建立 snapshot 期间先缓冲 live event，保证初始帧先于增量事件。
- replay 上限按该 Actor 的实际事件数计算，不使用全局 event ID 差值。
- 客户端断线会取消慢 probe 并释放 journal listener；应用关闭会主动终止已登记连接。
- 慢消费者和初始缓冲都有事件数/字节上限，溢出时要求客户端以 cursor 重连。
- terminal 事件携带真实资源状态，并在已提交的缓冲事件之后发送。

公开 read model 不包含 endpoint、model refs、owner ID、幂等键、原始 transport 错误、凭据或程序源码。Resources 工作台提供概览、动态、委派任务、基础感知以及程序/设置页；程序页会明确显示执行暂未开放。

## 可编程行为

程序采用两阶段契约：

1. `program.validate` 校验完整 Python 源码、API 版本、capability、source hash、Actor revision 和 AST 约束，生成短期 draft。
2. `program.activate` 以 draft ID、revision 和幂等键原子选择版本。

当前 Runtime 只验证和保存程序，不执行模型源码。AST 校验不是安全沙箱；开放执行前必须补独立 CPython worker、CPU/内存/墙钟预算、文件/网络/进程隔离、host API 白名单和租约取消。

## 接下来

1. 将已验证的真实聊天行为交给私有 Decision Runner，用低成本无思考模型验证“自然语言委派 → 游戏聊天 → 完成事件”的十秒级闭环。
2. 接入 Baritone/确定性控制层的移动、跟随和采集，再扩展实体/物品交互与战斗。
3. 增加独立 emergency-stop RPC 和 WebUI 按钮，并对真实客户端验证断联、卡住和危险中断。
4. 在移动能力稳定后开放受限空闲自治，验证无明确任务时的目标选择与打断。
5. 最后实现隔离 Python Worker；在此之前继续使用经过测试的确定性内建行为完成基础游玩。

真实模型 smoke 与延迟结论见 `docs/development/minecraft-decision-smoke.md`，本地 daemon 和父项目启动方式见 `docs/development/minecraft-actor-runtime.md`。

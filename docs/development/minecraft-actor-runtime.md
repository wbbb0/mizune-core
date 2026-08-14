# Minecraft Actor Runtime 开发联调

Minecraft Actor 是一个 owner-only 的持久系统资源。父项目负责会话、模型决策、持久经历、显著事件唤起和权限；`vendor/mizune-mc-runtime` daemon 负责结构化状态、确定性行为、任务队列、自治策略和 Python Program 生命周期。

当前 daemon 同时支持 simulation 与 `neoforge` 后端。动态服务器 binding、自然语言 delegate 和父进程 supervisor 已进入父项目：主 Bot 创建资源后，父进程会在每资源隔离的运行目录中拉起 daemon；NeoForge 后端再由 daemon 从受控启动档案拉起真实客户端。两者属于同一个 Runtime incarnation，并分别拥有可核验的独立进程组；父项目持久记录 daemon/client 各自的 PID、Linux start ticks、boot ID 与实例 ID。

NeoForge 1.21.1 Bridge 已实现受认证的 Unix socket v2 协议，并在完整 NeoForge/Create 镜像服上验证了真实客户端登录、玩家/实体/背包/环境快照、游戏聊天事件和普通全局聊天发送。Python daemon 会在开放父进程 socket 前验证 Bridge instance、目标服务器和首个完整快照，之后原子刷新快照并连续抽取多页事件；事件 cursor 过期会持久记录高优先级缺口后从最早保留位置恢复。真实聊天使用现有 `behavior.start(kind=chat)`、action lease、幂等命令和 `behavior_completed` 事件，未开放的移动/交互/战斗能力不会出现在 manifest。

## dev 启动

当前 worktree 的 `config/instances/dev.yml` 可配置 simulation 或 NeoForge 模板，允许主 Bot 直接接收“登录某服务器并完成某事”的自然语言委派。实际账号、可执行文件和游戏目录只存在本地配置，不进入 Git。

新 worktree 需要在本地实例配置中加入以下片段；客户端程序和目录必须写绝对路径。`gameDirectory` 必须是该受管身份专用的可写目录，不能直接复用日常客户端的游戏目录。大型只读安装资产可由受控 launcher 从独立 installation directory 读取，但 launcher 必须实际使用父进程注入的 `MIZUNE_MC_GAME_DIRECTORY` 作为游戏目录：

```yaml
minecraft:
  enabled: true
  eventPollIntervalMs: 500
  runtimeDir: /tmp/mizune-mc-dev
  clientProfiles:
    local-neoforge:
      identityRef: offline-dev
      executable: /absolute/path/to/xvfb-run
      arguments:
        - -a
        - /absolute/path/to/approved-launcher
      workingDirectory: /absolute/path/to/client-profile
      gameDirectory: /absolute/path/to/isolated-game-directory
      environment:
        LIBGL_ALWAYS_SOFTWARE: "1"
  templates:
    local-neoforge-1.21.1:
      backend: neoforge
      minecraftVersion: 1.21.1
      loader: neoforge
      gameProfileId: local-neoforge
      identityRef: offline-dev
      allowedServers:
        - 127.0.0.1:25566
      modelRefs:
        - ds_deepseek_v4_flash
      allowAutonomyPolicyChange: true
      allowProgramDeployment: true
      initialPersistentState: 尚无持久经历。
```

启动父项目即可由 supervisor 自动拉起每个 Actor 的 Runtime：

```bash
CONFIG_INSTANCE=dev npm run dev
```

仅在单独调试 framing/RPC 协议时，才手动运行一个不由资源 binding 使用的 daemon：

```bash
npm run dev:minecraft-runtime
```

受管 Runtime 的 socket、SQLite、PID 自登记、Bridge descriptor、客户端启动档案和认证 token 位于 `<runtimeDir>/<resourceId>/`；运行目录收敛为 `0700`，token 与启动档案为 `0600`。启动不经过 shell，模型不能提供可执行文件、参数或环境变量；这些值只能来自 `minecraft.clientProfiles`。token 内容不写入命令行、数据库或日志。正常 Actor 连接每次重连都会从持久 incarnation 重新解析 instance ID 和 token，防止连到旧 daemon。

## 真实客户端 smoke

以下 opt-in smoke 使用临时父项目数据库，实际启动已配置的 NeoForge 客户端，走完整的自然语言 delegate、supervisor、Python daemon、Bridge 首快照、结构化观察和一条普通游戏聊天行为。默认路径使用确定性调用并附带随机后缀，适合验证底层链路：

```bash
CONFIG_INSTANCE=dev npm run smoke:minecraft:managed-neoforge
```

smoke 与普通父项目 supervisor 共用 `0700` game directory 内的原子 profile 锁；不同 Runtime、不同父实例和并发 smoke 都不能同时启动同一客户端身份。锁以 `runtimeInstanceId` 持久标识 owner，因此父进程重启可接管同一 incarnation，但不能把别的 incarnation 当作陈旧锁自动删除。smoke 还会扫描对应目录与受控 launcher，作为人工启动客户端的第二道防线。结束时只有在 supervisor 确认安全收敛后才删除临时 Runtime 状态；失败或停止不完整时会保留临时目录供 PID/SQLite 对账。

Bridge 安全停机会在专用 game directory 留下持久重连锁。再次运行 smoke 代表 owner 明确恢复时，需显式确认：

```bash
CONFIG_INSTANCE=dev MIZUNE_MC_SMOKE_RESUME=1 npm run smoke:minecraft:managed-neoforge
```

该命令会删除这一个专用 profile 的重连锁，不应由普通模型循环自动设置。smoke 的默认 JSON 仅输出机器人状态与坐标、环境方块类型、有限背包摘要以及玩家/实体计数；仍只用于本地受控调试，不应接入普通聊天或集中日志。

要验证真实的私有 Decision Runner，可显式选择实例中已配置的低成本模型。smoke 会把“登录服务器，看看周围环境，然后在游戏聊天里向服务器里的大家打个简短的招呼”作为普通用户目标交给独立循环；模型以无思考模式运行，只能看到当前 Runtime 实际广告的只读接口、行为和终止工具：

```bash
CONFIG_INSTANCE=dev \
MIZUNE_MC_SMOKE_RESUME=1 \
MIZUNE_MC_SMOKE_DECISION_MODEL=ds_deepseek_v4_pro \
MIZUNE_MC_SMOKE_DECISION_TIMEOUT_MS=15000 \
npm run smoke:minecraft:managed-neoforge
```

模型路径同样要求游戏聊天中出现新消息，并在 JSON 中报告模型、决策耗时、工具调用数和 token usage；模型原始响应、完整玩家信息和认证数据不会进入普通输出。当前真实 NeoForge/Create 镜像服已经在 15 秒硬截止时间内用 v4 pro 完成该路径；同一目标的 v4 flash 无思考实测为 8.04 秒、4 次模型请求、8 个工具调用、18,654 tokens（其中 12,160 cached、reasoning 0）。这说明十秒级简单反应可行，但紧凑情景摘要和更高级行为包装仍是降低多轮读取与成本的下一项工作。若要比较其他 flash 版本，只需把模型引用改成实例中对应的 model ref。

父项目停机时会先中止独立决策循环，再对所有受管 Runtime 执行 TERM/KILL 收敛。每次发信号前都会重新校验 PID + start ticks + boot ID，且必须确认进程真正退出才写入终态。如无法识别或停止进程，supervisor 会保留 `stopping`/`needs_attention` 状态并让停机失败，不会伪装回收成功。

父项目停机时会先给正在进行的 owner notification 最多 5 秒收敛时间；超时则中止会话侧投递并保留 outbox 为 pending，避免单次模型生成阻塞整个应用退出。下次启动会按原 notification ID 重试。

Minecraft 模板、服务器 allowlist、身份引用、模型和权限属于 restart-required 配置。开发时修改后必须重启父项目；热重载会继续保留启动时策略，避免旧连接沿用已撤销权限或持久资源进入半迁移状态。

## 主 Bot 可见接口

启用 `minecraft_actor` 工具集后，owner 会话可以：

- `minecraft_actor_list`：列出当前 owner 的 Actor；
- `minecraft_actor_delegate`：接收服务器地址和自然语言任务，原子创建或复用 Actor 并排队首条任务；
- `minecraft_actor_request`：向持久 FIFO mailbox 委派目标并立即取得 request ID；
- `minecraft_actor_status`：读取独立循环、最近委派和身体状态的安全摘要；
- `minecraft_actor_interrupt`：打断当前一次模型决策；
- `minecraft_actor_close`：永久关闭资源并取消未完成委派。

结构化观察、实时行为、任务、自治和 Python Program 工具只存在于 Actor 自己的私有 Decision Runner 中，主 Bot 不可见。主 Bot 只提供 `server_address + instruction`；模板、身份、socket、Actor ID、决策模型和部署权限只能由服务端配置与 provisioner 给出。

同一服务器与身份在父项目中只允许一个 open binding。owner principal 负责授权，最初创建它的 session 是关注事件的通知路由；不会因为另一个会话查看资源而隐式转移。owner notification 使用 at-least-once 投递，极端崩溃窗口可能按同一 notification ID 重放。

WebUI 的「运行时资源 → Minecraft Actor」提供概览、SSE 动态、委派任务、基础感知和程序/设置页。当前程序执行与紧急停手按钮明确禁用，不应把 AST 校验或普通 interrupt 当成对应安全能力。

## 验证边界

默认父项目测试包含两个真实跨进程契约：一个验证 simulation daemon 的握手、行为与持久化；另一个让 supervisor 启动 Python daemon 和假 NeoForge 客户端，验证 Bridge 首快照门禁、daemon/client 双进程指纹、动态 capability 与成组停止。子模块自身测试覆盖 SQLite checkpoint、跨重启幂等、事件游标、deadline、cancel、heartbeat、控制租约安全停机，以及 NeoForge Bridge 的 framing、认证、单控制器租约、快照限额、显式事件缺口、多页 drain、聊天 mutation 和 live daemon 断线关闭。

真实 1.21.1 NeoForge/Create 离线镜像服已通过上述两种 opt-in smoke：父项目自然语言 delegate 能启动真实客户端，读取连接状态、坐标、环境方块、背包、玩家和实体；私有 Decision Runner 也能根据普通中文目标自行读取环境、选择当前唯一开放的聊天行为，并通过统一 behavior 状态机完成普通全局聊天。Decision Runner 在握手后按 Runtime manifest 动态裁剪 RPC、观察 scope 和行为种类，不能调用未开放的移动、交互或战斗能力；执行入口还会再次校验能力，不能靠伪造隐藏 tool call 绕过。

父项目与 Python Actor Runtime 使用独立的 v2 控制协议（不要与 Java Bridge v2 混淆）。读取结果保留数字 revision 供代码诊断，同时返回 Runtime 用持久 secret 签发的 `controlStateToken` 与审计用 `contextRef`。所有控制命令统一携带 `guard: { controlStateToken, conditionRefs }` 和 `provenance: { contextRef }`；当前 `conditionRefs` 必须为空数组，目标对象继续作为参数中的 opaque ref 传递。全局 observation revision 只表示观察水位，不再作为通用 mutation CAS，因此天气、游戏时间等无关观察刷新不会阻断聊天或坐标 `go_to`。

私有 Decision Runner 会在模型调用前自动预取 snapshot，并在后续 snapshot/observe 成功后单调更新内部 read state。模型消息、工具 schema 与工具结果不会暴露 revision、guard token、context ref 或幂等键；执行器从最近 read state 自动注入 guard/provenance，并从持久决策记录注入幂等键。Runtime 先处理幂等重放，再验证 control token；token 过期、被篡改、actor 或 runtime incarnation 不匹配时返回 `stale_control_state` / `after_refresh`，且不产生副作用。

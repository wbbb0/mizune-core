# Minecraft Actor Runtime 开发联调

Minecraft Actor 是一个 owner-only 的持久系统资源。父项目负责会话、模型决策、持久经历、显著事件唤起和权限；`vendor/mizune-mc-runtime` daemon 负责结构化状态、确定性行为、任务队列、自治策略和 Python Program 生命周期。

当前 daemon 同时支持 simulation 与 `neoforge_readonly` 后端。动态服务器 binding、自然语言 delegate 和父进程 supervisor 已进入父项目：主 Bot 创建资源后，父进程会在每资源隔离的运行目录中拉起 daemon；NeoForge 后端再由 daemon 从受控启动档案拉起真实客户端。两者属于同一个 Runtime incarnation，并分别拥有可核验的独立进程组；父项目持久记录 daemon/client 各自的 PID、Linux start ticks、boot ID 与实例 ID。

NeoForge 1.21.1 Bridge 已实现受认证的 Unix socket v2 协议，并在完整 NeoForge/Create 镜像服上验证了真实客户端登录、玩家/实体/背包/环境快照和游戏聊天事件。它目前只公布 `snapshot.get` 与 `events.list` 两个只读 RPC。Python daemon 会在开放父进程 socket 前验证 Bridge instance、目标服务器和首个完整快照，之后原子刷新快照并连续抽取多页事件；事件 cursor 过期会持久记录高优先级缺口后从最早保留位置恢复。断线、错服、客户端退出或协议漂移会关闭 Actor 控制面，且 live capability manifest 不会公布任何写接口。

## dev 启动

当前 worktree 的 `config/instances/dev.yml` 可配置 simulation 或 NeoForge 模板，允许主 Bot 直接接收“登录某服务器并完成某事”的自然语言委派。实际账号、可执行文件和游戏目录只存在本地配置，不进入 Git。

新 worktree 需要在本地实例配置中加入以下片段；客户端程序和目录必须写绝对路径：

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

默认父项目测试包含两个真实跨进程契约：一个验证 simulation daemon 的握手、行为与持久化；另一个让 supervisor 启动 Python daemon 和假 NeoForge 客户端，验证 Bridge 首快照门禁、daemon/client 双进程指纹、只读 capability 与成组停止。子模块自身测试覆盖 SQLite checkpoint、跨重启幂等、事件游标、deadline、cancel、heartbeat、控制租约安全停机，以及 NeoForge Bridge 的 framing、认证、单控制器租约、快照限额、显式事件缺口、多页 drain 和 live daemon 断线关闭。

下一阶段是在受控 dev 配置中用真实 1.21.1 NeoForge 客户端替换契约假客户端，完成父项目自然语言 delegate 的端到端联调。读链稳定后，再按 capability 逐项开放聊天发送、移动、交互和战斗，不改变已经由契约测试保护的父项目 RPC 和工具语义。

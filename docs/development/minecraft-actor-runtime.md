# Minecraft Actor Runtime 开发联调

Minecraft Actor 是一个 owner-only 的持久系统资源。父项目负责会话、模型决策、持久经历、显著事件唤起和权限；`vendor/mizune-mc-runtime` daemon 负责结构化状态、确定性行为、任务队列、自治策略和 Python Program 生命周期。

当前 daemon 使用模拟世界验证控制协议与生命周期。动态服务器 binding、自然语言 delegate 和父进程 supervisor 已进入父项目：主 Bot 创建资源后，父进程会在每资源隔离的运行目录中拉起 simulation daemon，并持久记录 PID、Linux start ticks、boot ID 和每次启动的 Runtime instance ID。NeoForge 模板目前会明确进入 `needs_attention`，尚未拉起真实客户端。父项目与未来真实 Bridge 之间保持同一套版本化 Actor RPC，避免在接入游戏时重写上层会话资源。

## dev 启动

当前 worktree 的 `config/instances/dev.yml` 可配置本地 simulation 运行模板，允许委派目标为 `127.0.0.1:25566`，使用 `ds_deepseek_v4_flash`。它会验证服务器解析、独立循环、行为与持久化，但在 NeoForge Bridge 落地前不会真正登录该服务器。实际配置和 `data/dev` 都是本地文件，不进入 Git。

新 worktree 需要在本地实例配置中加入以下片段；路径相对 `config/` 解析：

```yaml
minecraft:
  enabled: true
  eventPollIntervalMs: 500
  runtimeDir: /tmp/mizune-mc-dev
  templates:
    local-simulation-1.21.1:
      backend: simulation
      minecraftVersion: 1.21.1
      loader: vanilla
      gameProfileId: simulation
      identityRef: simulation-dev
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

受管 Runtime 的 socket、SQLite、PID 自登记和认证 token 位于 `<runtimeDir>/<resourceId>/`；运行目录收敛为 `0700`，token 为 `0600`。token 内容不写入命令行、数据库或日志。正常 Actor 连接每次重连都会从持久 incarnation 重新解析 instance ID 和 token，防止连到旧 daemon。

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

默认父项目测试包含一个真实跨语言契约测试：它启动 Python daemon，并验证握手、程序草稿事务、行为命令和事件读取。子模块自身测试覆盖 SQLite checkpoint、跨重启幂等、事件游标、deadline、cancel、heartbeat 和控制租约安全停机。

下一阶段接入真实客户端时，应先实现只读 Bridge（self、玩家、实体、背包、附近环境），再逐项替换模拟器底层；不要改变已经由契约测试保护的父项目 RPC 和工具语义。

# Minecraft Actor Runtime 开发联调

Minecraft Actor 是一个 owner-only 的持久系统资源。父项目负责会话、模型决策、持久经历、显著事件唤起和权限；`vendor/mizune-mc-runtime` daemon 负责结构化状态、确定性行为、任务队列、自治策略和 Python Program 生命周期。

当前 daemon 使用模拟世界验证控制协议与生命周期，还没有连接真实 NeoForge 客户端。父项目与未来真实 Bridge 之间保持同一套版本化 Actor RPC，避免在接入游戏时重写上层会话资源。

## dev 启动

当前 worktree 的 `config/instances/dev.yml` 已配置 endpoint `dev`，Actor ID 为 `mizune-dev`，使用 `ds_deepseek_v4_flash`。实际配置和 `data/dev` 都是本地文件，不进入 Git。

新 worktree 需要在本地实例配置中加入以下片段；路径相对 `config/` 解析：

```yaml
minecraft:
  enabled: true
  eventPollIntervalMs: 500
  endpoints:
    dev:
      actorId: mizune-dev
      socketPath: /tmp/mizune-mc-dev/runtime.sock
      modelRefs:
        - ds_deepseek_v4_flash
      allowAutonomyPolicyChange: true
      allowProgramDeployment: true
      initialPersistentState: 尚无持久经历。
      initialGoal: null
```

先在一个终端启动模拟 Runtime：

```bash
npm run dev:minecraft-runtime
```

再在另一个终端启动父项目：

```bash
CONFIG_INSTANCE=dev npm run dev
```

Runtime 的 Unix socket 位于 `/tmp/mizune-mc-dev/runtime.sock`，SQLite 位于 `data/dev/minecraft-runtime/runtime.sqlite`。socket 使用短路径是为了避开 Linux AF_UNIX 约 108 字节的路径上限；daemon 会把其父目录权限收敛为 `0700`。停止父项目只关闭本地 transport，不会隐式关闭远端 Actor；控制连接租约到期后，daemon 会取消活动行为和排队任务、关闭自治并进入安全状态。

父项目停机时会先给正在进行的 owner notification 最多 5 秒收敛时间；超时则中止会话侧投递并保留 outbox 为 pending，避免单次模型生成阻塞整个应用退出。下次启动会按原 notification ID 重试。

Minecraft endpoint、模型和权限配置属于 restart-required 配置。开发时修改后必须重启父项目；热重载会继续保留启动时策略，避免旧连接沿用已撤销权限或持久资源进入半迁移状态。

## 主 Bot 可见接口

启用 `minecraft_actor` 工具集后，owner 会话可以：

- `minecraft_actor_list`：列出 Actor 和可用 endpoint；
- `minecraft_actor_create`：创建或复用服务端预配置的 Actor；
- `minecraft_actor_request`：向持久 FIFO mailbox 委派目标并立即取得 request ID；
- `minecraft_actor_status`：读取独立循环、最近委派和身体状态的安全摘要；
- `minecraft_actor_interrupt`：打断当前一次模型决策；
- `minecraft_actor_close`：永久关闭资源并取消未完成委派。

结构化观察、实时行为、任务、自治和 Python Program 工具只存在于 Actor 自己的私有 Decision Runner 中，主 Bot 不可见。socket 路径、Actor ID、决策模型和部署权限只能由服务端配置给出；模型不能提供 transport 地址、revision 或幂等键。

同一个 endpoint/Actor 在父项目中只保留一个 active resource。owner principal 负责授权，最初创建它的 session 是关注事件的通知路由；不会因为另一个会话查看资源而隐式转移。owner notification 使用 at-least-once 投递，极端崩溃窗口可能按同一 notification ID 重放。

WebUI 的「运行时资源 → Minecraft Actor」提供概览、SSE 动态、委派任务、基础感知和程序/设置页。当前程序执行与紧急停手按钮明确禁用，不应把 AST 校验或普通 interrupt 当成对应安全能力。

## 验证边界

默认父项目测试包含一个真实跨语言契约测试：它启动 Python daemon，并验证握手、程序草稿事务、行为命令和事件读取。子模块自身测试覆盖 SQLite checkpoint、跨重启幂等、事件游标、deadline、cancel、heartbeat 和控制租约安全停机。

下一阶段接入真实客户端时，应先实现只读 Bridge（self、玩家、实体、背包、附近环境），再逐项替换模拟器底层；不要改变已经由契约测试保护的父项目 RPC 和工具语义。

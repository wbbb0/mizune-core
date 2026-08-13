# Minecraft Actor Runtime 开发联调

Minecraft Actor 是一个 owner-only 的持久系统资源。父项目负责会话、模型决策、持久经历、显著事件唤起和权限；`vendor/mizune-mc-runtime` daemon 负责结构化状态、确定性行为、任务队列、自治策略和 Python Program 生命周期。

当前 daemon 使用模拟世界验证控制协议与生命周期，还没有连接真实 NeoForge 客户端。父项目与未来真实 Bridge 之间保持同一套版本化 Actor RPC，避免在接入游戏时重写上层会话资源。

## dev 启动

当前 worktree 的 `config/instances/dev.yml` 已配置 endpoint `dev`，Actor ID 为 `mizune-dev`，使用 `ds_deepseek_v4_flash`。实际配置和 `data/dev` 都是本地文件，不进入 Git。

先在一个终端启动模拟 Runtime：

```bash
npm run dev:minecraft-runtime
```

再在另一个终端启动父项目：

```bash
CONFIG_INSTANCE=dev npm run dev
```

Runtime 的 Unix socket 与 SQLite 位于 `data/dev/minecraft-runtime/`。停止父项目只关闭本地 transport，不会隐式关闭远端 Actor；控制连接租约到期后，daemon 会取消活动行为和排队任务、关闭自治并进入安全状态。

## 模型可见接口

启用 `minecraft_actor` 工具集后，owner 会话可以：

- 列出、创建、探测和关闭服务端预配置的 Actor resource；
- 查询自身、环境、背包、实体、玩家、聊天和任务状态；
- 启动移动、跟随、交互、拾取、聊天和战斗行为；
- 提交或取消持久任务，修改已授权的空闲自治策略；
- 获取、验证并原子激活版本化 Python Program；
- 手动唤起上层决策，或立即推进一次事件 outbox。

socket 路径、Actor ID、决策模型和部署权限只能由服务端配置给出。模型不能提供 transport 地址、revision 或幂等键；父项目在执行前读取当前快照，并从 session ID、tool call ID、resource ID 和动作类型派生稳定幂等键。

## 验证边界

默认父项目测试包含一个真实跨语言契约测试：它启动 Python daemon，并验证握手、程序草稿事务、行为命令和事件读取。子模块自身测试覆盖 SQLite checkpoint、跨重启幂等、事件游标、deadline、cancel、heartbeat 和控制租约安全停机。

下一阶段接入真实客户端时，应先实现只读 Bridge（self、玩家、实体、背包、附近环境），再逐项替换模拟器底层；不要改变已经由契约测试保护的父项目 RPC 和工具语义。

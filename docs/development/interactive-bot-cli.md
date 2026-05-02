# 交互式 Bot 测试 CLI

`npm run test:interactive-bot` 用于在本地启动一个可交互的测试运行时。它使用假的 OneBot 客户端接入真实消息入口，因此普通文本会经过正式的消息解析、用户身份、会话、直接指令、生成与上下文链路。

这个工具只面向开发和测试，不作为正式使用入口。

## 启动

使用某个实例的真实 provider 配置：

```bash
CONFIG_INSTANCE=acc1 npm run test:interactive-bot
```

也可以通过参数指定实例：

```bash
npm run test:interactive-bot -- --instance acc1
```

如果真实实例配置没有复制到当前 worktree，可以直接指定配置文件：

```bash
CONFIG_INSTANCE_FILE=/path/to/prod_deepseek.yml npm run test:interactive-bot
```

需要临时切换 LLM 路由预设时使用 `--routing-preset`：

```bash
CONFIG_INSTANCE=acc1 npm run test:interactive-bot -- --routing-preset prod_deepseek
CONFIG_INSTANCE=acc1 npm run test:interactive-bot -- --routing-preset local_qwen
```

默认会使用隔离数据目录 `data/interactive-<instance>`，避免污染实例正式运行数据。需要指定测试数据目录时：

```bash
CONFIG_INSTANCE=acc1 npm run test:interactive-bot -- --data-dir data/interactive-acc1
```

需要临时复用实例原数据时可以加 `--use-instance-data`，但这会直接读写该实例的数据文件。

## 默认关闭的能力

为了降低成本和避免测试副作用，CLI 会在运行时覆盖配置，关闭以下能力：

- OneBot 真实网络连接，改用内存 fake OneBot。
- internal API 和 WebUI。
- scheduler、ComfyUI、shell、browser。
- 搜索 provider。
- whitelist。
- 后台维护任务和配置热重载。

LLM 与 embedding provider 不会被替换，仍然来自所选实例配置和当前 `llm.routingPreset`。使用 `--routing-preset prod_deepseek` 或 `--routing-preset local_qwen` 时，只覆盖运行时的路由预设，不修改配置文件。

## 可用命令

- `/status`：查看当前会话、context store、embedding 与最近召回状态。
- `/context`：查看当前用户的 context items。
- `/retrieve <query>`：以当前用户身份执行 context 召回，便于单独验证记忆是否会进入生成上下文。
- `/rebuild-context`：补齐当前用户 embedding 并重建检索索引。
- `/wait [ms]`：等待会话处理完成，脚本化触发真实 LLM 生成时使用。
- `/user <id>`：切换发送用户。
- `/name <name>`：切换发送昵称。
- `/private`：切换为私聊。
- `/group <id>`：切换为群聊。
- `/at on|off`：群聊时是否 @ bot。
- `/quit`：退出。

除 `/` 开头的 CLI 命令外，其他输入都会作为用户消息进入正式消息链路。例如：

```text
.remember 我喜欢 Orama 测试
/context
```

## 自动准备状态

隔离数据目录首次启动时，CLI 会自动准备一个可用的测试 owner 和 setup-ready 状态，避免 `.remember` 或普通聊天被初始化流程拦截。`/context` 会把当前 OneBot 外部用户 ID 解析为内部 userId 后再查询，因此能看到真实链路写入的数据。

## 脚本化烟测

CLI 支持非 TTY 管道输入，便于未来功能复用：

```bash
printf '.remember 我喜欢 Orama 测试\n/context\n/quit\n' \
  | CONFIG_INSTANCE=acc1 npm run test:interactive-bot -- --routing-preset prod_deepseek --data-dir data/interactive-smoke
```

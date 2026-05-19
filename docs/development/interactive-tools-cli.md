# 交互式工具测试 CLI

`npm run test:interactive-tools` 用于启动一个隔离的本地运行时，并绕过 LLM 直接调用项目内置工具。它适合验证工具 schema、参数解析、权限、上下文依赖与真实 handler 行为。

这个工具只面向开发和测试，不作为正式使用入口。

## 启动

使用某个实例的真实配置：

```bash
CONFIG_INSTANCE=acc1 npm run test:interactive-tools
```

也可以通过参数指定实例：

```bash
npm run test:interactive-tools -- --instance acc1
```

默认使用隔离数据目录 `data/interactive-<instance>`。需要指定数据目录时：

```bash
CONFIG_INSTANCE=acc1 npm run test:interactive-tools -- --data-dir data/interactive-tools-acc1
```

需要临时复用实例正式数据时可以加 `--use-instance-data`，但这会直接读写该实例的数据文件。

## 默认关闭的能力

为了降低测试副作用，CLI 默认关闭 shell、browser、ComfyUI 和搜索 provider。需要测试这些工具时显式打开：

```bash
CONFIG_INSTANCE=acc1 npm run test:interactive-tools -- --enable-shell
CONFIG_INSTANCE=acc1 npm run test:interactive-tools -- --enable-browser
CONFIG_INSTANCE=acc1 npm run test:interactive-tools -- --enable-search
CONFIG_INSTANCE=acc1 npm run test:interactive-tools -- --enable-comfy
```

debug 工具默认不暴露。需要测试时使用 `--include-debug-tools`，或进入 CLI 后执行 `/debug on`。

需要让输出更适合脚本解析时使用 `--quiet --json`。`--quiet` 会把测试运行时日志降到 silent，并隐藏 banner 与 fake OneBot 发送提示；`--json` 会隐含 `--quiet`，并把工具调用结果压成单行 JSON。

通过 npm 脚本做机器解析时，建议使用 `npm --silent run test:interactive-tools -- ... --json`，避免 npm 自己的脚本提示混入 stdout。

## 可用命令

- `/tools [filter]`：列出当前上下文可调用的工具。
- `/all-tools [filter]`：列出所有注册工具及当前配置可用性。
- `/schema <toolName>`：查看工具 schema。
- `/call <toolName> <jsonArgs>`：直接调用工具。
- `/session`：查看当前调用上下文。
- `/user <id>`：切换外部用户 ID。
- `/name <name>`：切换发送昵称。
- `/private`：切换到私聊上下文。
- `/group <id>`：切换到群聊上下文。
- `/debug on|off`：切换 debug 工具可见性。
- `/quit`：退出。

示例：

```text
/tools filesystem
/schema filesystem_list
/call list_session_modes {}
/call get_persona {}
```

也可以直接输入一行 JSON：

```json
{"tool":"roll_dice","args":{"expression":"2d6+1"}}
```

## 单次调用

脚本支持非交互式单次调用，便于自动化或 agent 直接验证：

```bash
CONFIG_INSTANCE=acc1 npm run test:interactive-tools -- \
  --tool get_persona \
  --args '{}'
```

测试 shell 工具：

```bash
CONFIG_INSTANCE=acc1 npm run test:interactive-tools -- \
  --enable-shell \
  --tool terminal_run \
  --args '{"command":"pwd","timeout_ms":5000,"notify_policy":"none"}'
```

参数较大时可用 `--args-file <json-file>`。

如果工具 handler 抛出异常，CLI 会返回结构化错误而不是退出 REPL。例如越界 `cwd`、不存在文件等错误会以 `{ "ok": false, "error": "...", "errorKind": "exception" }` 形式返回。工具正常返回但结果内包含业务错误 `{ "error": "..." }`，或返回 `{ "ok": false, "message": "..." }` 时，CLI 也会把本次调用标记为失败，并设置 `errorKind: "tool_result"`。单次调用遇到任一工具错误时进程退出码为 1。

## 批量调用与并行

`--batch <json-file>` 可以一次运行多条工具调用。文件可以是调用数组：

```json
[
  { "id": "dice", "tool": "roll_dice", "args": { "expression": "1d6" } },
  { "id": "modes", "tool": "list_session_modes", "args": {} }
]
```

也可以写成带默认并发数的对象：

```json
{
  "parallel": 2,
  "calls": [
    { "tool": "roll_dice", "args": { "expression": "1d6" } },
    { "tool": "get_persona", "args": {} }
  ]
}
```

运行：

```bash
CONFIG_INSTANCE=acc1 npm --silent run test:interactive-tools -- \
  --data-dir data/interactive-tools-batch \
  --batch /tmp/tool-batch.json \
  --parallel 2 \
  --json
```

批量输出的 `ok/passed/failed` 会同时统计异常和工具业务错误，适合 CI 或 agent 过程测试直接判断失败项。并行批量调用共享同一个测试运行时和同一个 session 上下文，只适合互相独立的读取或轻量验证。会修改共享状态的工具建议顺序执行，或为不同测试进程指定不同 `--data-dir`。

## 脚本化烟测

CLI 支持管道输入：

```bash
printf '/tools dice\n/call roll_dice {\"expression\":\"1d6\"}\n/quit\n' \
  | CONFIG_INSTANCE=acc1 npm run test:interactive-tools -- --data-dir data/interactive-tools-smoke
```

隔离数据目录首次启动时，CLI 会自动准备 owner 绑定和 setup-ready 状态，避免工具调用被初始化流程拦截。

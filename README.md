# Mizune Core

Mizune Core 是一个基于 Node.js / TypeScript 的长期运行 LLM 聊天代理服务。它既可以作为 OneBot 机器人的后端，也可以不接入任何 bot，仅通过内置 WebUI 在本地或内网管理会话、配置与运行数据。

项目重点不只是“转发消息给模型”，而是围绕长期会话运行做了一整套编排：会话状态、历史压缩、回复门控、发送队列、persona / 用户资料 / 记忆持久化、工具调用、内部 API 与 WebUI。

## 适合场景

- 运行一个可接入 QQ / OneBot 的 LLM 机器人后端
- 在本地或内网部署一个带 WebUI 的私有 LLM 会话服务
- 观察和调试长期会话、persona、记忆、工具调用与消息投递流程
- 作为带 shell、workspace、浏览器、搜索、ComfyUI 等能力的代理运行时

## 功能概览

- OneBot 事件接入与消息发送
- WebUI 会话与 OneBot 会话并存
- 会话级模式切换，当前内置 `rp_assistant` 与 `scenario_host`
- persona、RP / Scenario 资料、用户资料、记忆和规则持久化
- LLM provider / model / routing preset 分层配置
- 历史压缩、自动会话标题、图片说明、音频转写、turn planner
- shell、workspace 文件、网页搜索、浏览器、ComfyUI 等可选工具能力
- Fastify 内部 API 与 Vue 3 + Tailwind WebUI

## 技术栈

- 后端：Node.js 20.19+、TypeScript、Fastify、Zod、pino
- 前端：Vue 3、Vite、Tailwind CSS
- 测试与构建：node:test、tsx、tsdown、Playwright

## 快速开始

详细配置步骤见 [快速上手](docs/getting-started.md)。最短流程如下：

```bash
npm install
npm --prefix webui install

cp config/global.example.yml config/global.yml
cp config/llm.providers.example.yml config/llm.providers.yml
cp config/llm.models.example.yml config/llm.models.yml
cp config/llm.routing-presets.example.yml config/llm.routing-presets.yml
cp config/instances/acc1.example.yml config/instances/default.yml
```

然后编辑这些配置：

- `config/llm.providers.yml`：填写 provider 的 `apiKey` / `baseUrl`
- `config/llm.models.yml`：确认模型引用指向可用 provider
- `config/llm.routing-presets.yml`：确认默认 preset 引用到存在的模型
- `config/global.yml`：开启 `llm`、`internalApi.webui`，或关闭 `onebot`
- `config/instances/default.yml`：设置当前实例的数据目录、端口和 OneBot 地址

开发态启动：

```bash
npm run dev
```

默认 WebUI 地址通常是：

```text
http://127.0.0.1:3031/webui/#/sessions
```

首次开启 WebUI 认证时，登录口令会自动写入当前实例数据目录下的 `webui-auth.json`，同时在控制台输出提示。

## 常用命令

```bash
npm run dev              # 同时启动后端和 WebUI 开发服务
npm run dev:bot          # 只启动后端开发进程
npm run dev:webui        # 只启动 WebUI 开发服务

npm run build            # 构建后端和 WebUI
npm run start:bot        # 启动生产后端，WebUI 可由后端托管

npm run typecheck:all    # TypeScript 检查
npm run test             # 后端测试 + WebUI 构建检查
```

如果要使用 Playwright 浏览器能力，需要额外安装浏览器：

```bash
npm run install:browsers
```

## 配置模型

配置分成“目录文件”和“运行时配置层”两类。

目录文件定义可引用对象，不参与实例覆盖：

- `config/llm.providers.yml`
- `config/llm.models.yml`
- `config/llm.routing-presets.yml`

运行时配置层按顺序合并：

1. `config/global.yml`
2. `config/instances/<instance>.yml`

默认实例名是 `default`，因此默认读取 `config/instances/default.yml`。可以用环境变量切换实例：

```bash
CONFIG_INSTANCE=acc1 npm run dev
```

也可以直接指定实例配置文件：

```bash
CONFIG_INSTANCE_FILE=config/instances/acc1.yml npm run dev
```

更多配置说明见 [快速上手](docs/getting-started.md#配置文件职责)。

## 运行模式

### WebUI-only

适合先验证模型调用、会话流程和 WebUI，不接 OneBot：

```yml
onebot:
  enabled: false

internalApi:
  enabled: true
  webui:
    enabled: true

llm:
  enabled: true
```

### OneBot + WebUI

适合实际接入 QQ / OneBot，同时保留 WebUI 作为观察与管理入口：

```yml
onebot:
  enabled: true
  provider: generic
  wsUrl: ws://127.0.0.1:3001
  httpUrl: http://127.0.0.1:3000
  historyBackfill:
    enabled: true
    maxMessagesPerSession: 20
    maxTotalMessages: 100
    requestDelayMs: 100

internalApi:
  enabled: true
  webui:
    enabled: true

llm:
  enabled: true
```

如果 OneBot 端需要鉴权，在 `onebot.accessToken` 中配置 token。

历史补全默认启用，但只有 `provider: napcat` 会调用 OneBot 扩展历史接口。`generic` OneBot 会跳过该能力。

如果你接的是 NapCat，并希望启动时只为已经存在的 OneBot 会话补全服务中断期间的 QQ 历史消息，可以这样配置：

```yml
onebot:
  provider: napcat
  historyBackfill:
    enabled: true
    maxMessagesPerSession: 20
    maxTotalMessages: 100
    requestDelayMs: 100
```

历史补全只写入会话历史，不进入回复触发、排队和生成流程。

## 项目结构

```text
src/          后端源码
webui/        Vue 3 + Tailwind WebUI
config/       运行配置与示例配置
data/         本地运行时数据
docs/         长期维护文档
test/         回归测试与测试辅助代码
deploy/       systemd 服务示例
```

`src/` 内部按运行域拆分：

- `app/`：启动、生成、消息、运行时和会话工作流编排
- `conversation/`：会话状态、历史、压缩、reply gate 等
- `llm/`：模型接入、prompt、工具注册与调用链路
- `services/`：OneBot、shell、web、workspace 等外部能力封装
- `internalApi/`：内部 HTTP API、应用服务与 WebUI 托管
- `memory/`、`persona/`、`modes/`：长期状态和模式相关能力

## 文档

- [快速上手](docs/getting-started.md)
- [会话与资料模型](docs/architecture/session-and-profile-model.md)
- [WebUI Workbench 架构](docs/architecture/webui-workbench.md)
- [记忆架构](docs/memory-architecture.md)
- [编辑器 Schema 元数据](docs/development/editor-schema-metadata.md)

## 部署

生产构建：

```bash
npm run build
CONFIG_INSTANCE=acc1 npm run start:bot
```

`deploy/` 中提供了 systemd 示例，`llm-bot@.service` 使用 `%i` 作为实例名：

```bash
systemctl --user enable --now llm-bot@acc1
```

这会读取 `config/instances/acc1.yml`。

## 数据持久化

默认 `dataDir: data` 会按实例名展开，例如：

- `default` -> `data/default`
- `acc1` -> `data/acc1`

会话、persona、users、whitelist、workspace、WebUI 登录数据等都会按实例隔离。

## 开发约定

提交前至少运行：

```bash
npm run typecheck:all
npm run test
```

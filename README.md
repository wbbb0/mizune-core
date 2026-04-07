# Mizune Core

`Mizune Core` 是一个面向长期运行聊天代理的 Node.js/TypeScript 运行时。

它的核心不是某个单一协议，而是：

- 会话编排与历史持久化
- persona、用户资料与记忆管理
- LLM 调用链与工具调用
- WebUI 监控、配置编辑、数据编辑
- 可选消息入口与输出通道

当前仓库已经支持两种运行方式：

- `WebUI-only`：不连接 OneBot，仅通过 WebUI 创建会话和发起对话
- `OneBot + WebUI`：接入 OneBot 消息流，同时保留 WebUI 监控与管理能力

OneBot 现在是可选传输层，不再是项目的唯一中心。

## 核心能力

**会话运行时**

- 维护 session 生命周期、pending 队列、debounce、生成取消与恢复
- 支持 transcript、历史摘要压缩、reply gate、新话题检测
- 支持 Web session 与 OneBot session 并存

**LLM 与工具**

- 多 provider / 多模型路由
- 内置工具框架，支持 shell、网页浏览、搜索、工作区、记忆管理、调度等
- 支持 ComfyUI、搜索、浏览器会话等可选能力

**数据与身份**

- persona、users、global memories、session 数据本地持久化
- 白名单与管理者绑定逻辑仍可用于 OneBot 场景
- WebUI-only 模式下不依赖 OneBot owner bootstrap

**WebUI**

- 会话页：查看 transcript、直接发起 Web 会话、发送消息、删除 Web 会话
- 配置编辑器：按 schema 展示并校验配置
- 数据编辑器 / Data Browser / Workspace

## 运行模式

### WebUI-only

适合把它当作本地或内网的 LLM 会话运行时来用。

特点：

- 不连接 OneBot
- 不产生 OneBot 重连噪声
- 通过 WebUI 新建 `web:*` 会话
- 通过 WebUI 直接发起消息、查看 transcript、管理配置和数据

关键配置：

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

适合把它接到 QQ / OneBot 生态里运行。

特点：

- 接收 OneBot 消息事件
- 保留私聊/群聊、转发、reply、mention 等 OneBot 场景能力
- 支持 OneBot 场景下的管理者绑定与白名单逻辑

关键配置：

```yml
onebot:
  enabled: true
  wsUrl: ws://127.0.0.1:3001
  httpUrl: http://127.0.0.1:3000
```

## 架构概览

```text
消息入口(OneBot / WebUI)
        ↓
会话编排(session / gate / transcript / persistence)
        ↓
LLM 调用链(tool loop / routing / prompt)
        ↓
工具运行时(shell / browser / search / workspace / comfy)

Internal API(Fastify) → WebUI(Vue 3 + Tailwind)
```

## 环境要求

- Node.js 20+
- 已配置的 LLM API
- 如果使用 OneBot 模式：任一可用的 OneBot 实现

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 准备配置

```bash
cp config/global.example.yml config/global.yml
cp config/llm.providers.example.yml config/llm.providers.yml
cp config/llm.models.example.yml config/llm.models.yml
mkdir -p config/instances
touch config/instances/default.yml
```

至少需要配置：

- `llm.enabled: true`
- `config/llm.providers.yml`
- `config/llm.models.yml`
- `llm.mainRouting.smallModelRef` / `llm.mainRouting.largeModelRef`

如果要跑 WebUI-only：

- `onebot.enabled: false`
- `internalApi.enabled: true`
- `internalApi.webui.enabled: true`

如果要跑 OneBot：

- `onebot.enabled: true`
- `onebot.wsUrl`
- `onebot.httpUrl`
- `onebot.accessToken`（如有）

### 3. 启动

```bash
npm run dev
```

多实例：

```bash
CONFIG_INSTANCE=mybot npm run dev
```

## 开发命令

```bash
npm run dev
npm run dev:bot
npm run dev:webui

npm run build
npm run build:bot
npm run build:webui

npm run test
npm run typecheck:all
```

如需 Playwright 浏览能力：

```bash
npm install playwright
npm run install:browsers
```

## 配置结构

加载优先级如下，后者覆盖前者：

1. `config/llm.providers.yml`
2. `config/llm.models.yml`
3. `config/global.yml`
4. `config/instances/<instance>.yml`

推荐分层：

| 配置层 | 建议放置内容 |
|--------|--------------|
| `llm.providers.yml` | provider、apiKey、baseUrl、provider features |
| `llm.models.yml` | 模型目录、能力标注、provider 归属 |
| `global.yml` | 共享运行策略、超时、工具开关 |
| `instances/<instance>.yml` | 实例特有项：数据目录、端口、模型引用、OneBot 地址 |

常用配置项：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `onebot.enabled` | 是否启用 OneBot 连接 | `true` |
| `llm.enabled` | 是否启用 LLM | `false` |
| `internalApi.enabled` | 是否启用内部 API | `false` |
| `internalApi.webui.enabled` | 是否启用 WebUI | `false` |
| `whitelist.enabled` | 是否启用 OneBot 白名单 | `true` |
| `scheduler.enabled` | 是否启用调度器 | `true` |
| `browser.enabled` | 是否启用网页浏览工具 | `false` |
| `shell.enabled` | 是否启用 shell 工具 | `false` |
| `comfy.enabled` | 是否启用 ComfyUI | `false` |

完整示例见 [config/global.example.yml](/home/wbbb/Workspace/nodejs/llm-onebot/config/global.example.yml)。

## WebUI

默认生产地址由 `internalApi.webui.port` 决定：

- `http://localhost:3031/webui/`

开发时可以单独启动：

```bash
npm run dev:webui
```

手动覆盖开发代理：

```bash
VITE_API_TARGET=http://localhost:3030 npm run dev:webui
VITE_DEV_PORT=5174 npm run dev:webui
```

当前 WebUI 能力包括：

- 查看会话列表与实时 transcript
- 创建和删除 Web 会话
- 在 Web 会话中直接发消息
- 编辑配置与数据
- 浏览工作区和资源

## Internal API

主要接口包括：

- 健康检查
- 配置摘要
- session 列表、详情、创建、删除
- Web turn 与 SSE session stream
- 上传资产
- shell / browser / workspace 管理接口

说明：

- `POST /api/send-text` 只在 OneBot 启用时可用
- `POST /api/sessions` / `DELETE /api/sessions/:sessionId` 面向 Web 会话
- `POST /api/sessions/:sessionId/web-turn` 只接受 Web session

## 部署

### systemd

`deploy/` 目录提供了当前使用的 service 模板：

- `deploy/llm-bot@.service`
- `deploy/llm-bot-dev@.service`
- `deploy/llm-bot-dev-webui@.service`
- `deploy/llm-bot.service`

示例：

```bash
systemctl --user enable --now llm-bot@mybot
```

### Nginx 反向代理

如果通过 Nginx 暴露 WebUI，需要关闭缓冲，保证 SSE 正常：

```nginx
location / {
  proxy_pass http://localhost:3031;

  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Connection "";

  proxy_buffering off;
  proxy_request_buffering off;
  proxy_cache off;
  gzip off;

  add_header X-Accel-Buffering no always;
}
```

## 持久化数据

默认数据目录为 `data/<instance>/`，主要包括：

- sessions
- persona
- users
- global memories
- whitelist
- scheduled jobs
- workspace / media
- WebUI auth 数据

## 测试与约束

提交前建议至少运行：

```bash
npm run typecheck:all
npm run test
```

项目内 prompt 默认使用中文；配置、测试与文档也应与中文 prompt 约定保持一致。

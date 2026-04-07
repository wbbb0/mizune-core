# synapse-onebot

一个基于 OneBot 协议的 Node.js/TypeScript LLM 代理服务，具备会话编排、persona 与记忆持久化、工具调用、定时任务、WebUI 监控等完整能力。

## 功能特性

**消息链路**
- 接入 OneBot：通过 WebSocket 收消息，通过 HTTP API 发私聊/群聊消息
- 支持私聊、群聊、图片输入、合并转发输入、reply/mention 结构化输入
- 流式回复、分段发送、发送串行化

**会话管理**
- 按私聊/群聊维度维护 session，支持 debounce、生成取消、历史持久化与恢复
- 历史压缩摘要、最近消息窗口、群聊 `@` 触发限制
- reply gate：由小模型前置判断是否回复/等待，支持新话题检测

**persona 与记忆**
- 本地持久化 persona、用户资料与 relationship 信息
- 分层记忆：persona 级全局记忆、user 级个人记忆条目
- 工具调用接口支持新增、删除、覆写记忆条目
- 对话时仅注入当前触发用户的记忆，不扩散到其他用户

**工具调用**
- 内置工具框架，支持调试、资料编辑、记忆管理、白名单管理、请求审批
- 外部搜索：Google Grounding 搜索、阿里云 IQS UnifiedSearch
- 网页浏览：静态抓取 + Playwright 会话，统一页面资源管理
- Shell/tmux：命令执行、stdin 写入、异步 job、PTY 支持、tmux 会话管理
- ComfyUI 图像生成（可选）
- 定时任务：delay、at、cron 三种调度，任务状态持久化

**配置系统**
- 分层配置：全局配置、LLM provider/model 目录、实例级覆盖
- 配置容错：语法损坏跳过、未知键忽略、字段级降级，尽量保持运行
- WebUI 可视化配置编辑器，支持实时校验与保存

**WebUI**
- 会话聊天页与后台记录页，基于 SSE 实时更新
- 聊天页仅展示真实 OneBot 消息，后台记录页展示完整 transcript
- 配置编辑器、数据编辑器

**内部 API**
- 可选 Fastify HTTP 服务
- 提供健康检查、配置摘要、会话管理、主动发消息等接口

## 架构概览

```
OneBot ←→ WebSocket/HTTP → Bot层 → 会话编排 → LLM 调用链
                                              ↕
                               工具(shell/search/browser/comfy)
                               persona/memory 持久化
                               定时任务调度

内部 API (Fastify) → WebUI (Vue 3 + Tailwind)
```

**Prompt 结构**
- `system`：规则、persona、摘要、用户资料、资源轨迹
- `recentMessages`：近期可见事件流
- `trigger batch`：本轮待处理输入
- 结构边界统一使用 `⟦...⟧` 标记（section、history_message、trigger_batch 等）
- 图片/转发/回复等媒体资源统一保留资源 ID，按需展开

## 环境要求

- Node.js 20+
- 可用的 OneBot 实现（如 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)、[LLOneBot](https://github.com/LLOneBot/LLOneBot) 等）
- 已配置的 LLM API（OpenAI 兼容接口、Google AI Studio、Vertex AI、阿里云 DashScope 等）

## 快速开始

### 安装依赖

```bash
npm install
```

### 准备配置

1. 复制示例配置并填入实际参数：

```bash
cp config/global.example.yml config/global.yml
cp config/llm.providers.example.yml config/llm.providers.yml
cp config/llm.models.example.yml config/llm.models.yml
mkdir -p config/instances
# 创建实例配置（不传 CONFIG_INSTANCE 时默认使用 default）
touch config/instances/default.yml
```

2. 至少配置以下字段：
   - `onebot.wsUrl` / `onebot.httpUrl` — OneBot 地址
   - `onebot.accessToken` — OneBot 鉴权 token（如有）
   - `llm.enabled: true` — 启用 LLM
   - `config/llm.providers.yml` — provider 接入方式与 API key
   - `config/llm.models.yml` — 模型目录、能力标注与 provider 归属
   - `llm.mainRouting.smallModelRef` / `largeModelRef` — 主模型引用

3. 启动：

```bash
npm run dev
```

多实例时通过 `CONFIG_INSTANCE` 选择实例：

```bash
CONFIG_INSTANCE=mybot npm run dev
```

### 开发模式

`npm run dev` 会同时启动 bot 后端（tsx watch）和 WebUI 的 Vite 开发服务器，支持 HMR。

```bash
npm run dev          # bot + WebUI dev server
npm run dev:bot      # 仅 bot 后端
npm run dev:webui    # 仅 WebUI dev server
```

WebUI 地址由 `internalApi.webui.port` 决定，默认 `http://localhost:3031/webui/`。

如需手动覆盖代理目标或端口：

```bash
VITE_API_TARGET=http://localhost:3030 npm run dev:webui
VITE_DEV_PORT=5174 npm run dev:webui
```

### 测试

```bash
npm run test
npm run typecheck:all
```

### 构建

```bash
npm run build        # bot + WebUI
npm run build:bot
npm run build:webui
```

如需 Playwright 浏览后端：

```bash
npm install playwright
npm run install:browsers
```

### 生产启动

```bash
npm run start:bot
```

## 配置说明

配置文件位于 `config/`，加载优先级（后者覆盖前者）：

1. `config/llm.providers.yml` — LLM provider 目录
2. `config/llm.models.yml` — LLM model 目录
3. `config/global.yml` — 全局共享运行配置
4. `config/instances/<instance>.yml` — 实例级覆盖（可选）

**推荐分层策略：**

| 配置层 | 适合放置的内容 |
|--------|---------------|
| `llm.providers.yml` | provider 目录、API key、baseUrl、provider features |
| `llm.models.yml` | 模型目录、modelType、模型能力、provider 归属 |
| `global.yml` | 所有实例共用的运行策略、超时、搜索/浏览/shell 开关 |
| `instances/<instance>.yml` | 实例特有项：OneBot 端口、dataDir、internalApi 端口、modelRef |

**常用开关：**

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `llm.enabled` | 启用 LLM 调用 | `false` |
| `conversation.group.requireAtMention` | 群聊需 @ 触发 | `true` |
| `whitelist.enabled` | 启用用户/群白名单 | `true` |
| `internalApi.enabled` | 启用内部 HTTP API | `false` |
| `internalApi.webui.enabled` | 启用 WebUI | `false` |
| `scheduler.enabled` | 启用定时任务 | `true` |
| `search.googleGrounding.enabled` | 启用 Google 搜索 | `false` |
| `search.aliyunIqs.enabled` | 启用阿里云 IQS 搜索 | `false` |
| `browser.enabled` | 启用网页浏览工具 | `false` |
| `shell.enabled` | 启用 shell 工具 | `false` |
| `comfy.enabled` | 启用 ComfyUI 图像生成 | `false` |

完整配置参见 `config/global.example.yml`。

**支持的 LLM provider 类型：**

- `openai` — OpenAI 及所有兼容接口（默认）
- `google` — Google AI Studio
- `vertex` — Vertex AI Gemini（需配置完整 baseUrl 和 access token）
- `vertex_express` — Vertex AI Express Mode（使用 API key）
- `dashscope` — 阿里云 DashScope
- `lmstudio` — LM Studio 本地服务

**实例选择环境变量：**

- `CONFIG_INSTANCE` — 实例名，对应加载 `config/instances/<instance>.yml`，默认 `default`
- `CONFIG_DIR` — 配置目录，默认 `./config`
- `CONFIG_INSTANCE_FILE` — 直接指定实例配置文件路径（优先于 CONFIG_INSTANCE）

## 部署

### systemd 服务

`deploy/` 目录提供了 systemd service 示例：

- `deploy/llm-bot@.service` — 生产服务（实例化，依赖构建产物）
- `deploy/llm-bot-dev@.service` — 开发服务（实例化，运行 `dev:bot`）
- `deploy/llm-bot-dev-webui@.service` — 开发 WebUI 服务（支持 HMR）
- `deploy/llm-bot.service` — 单实例生产服务示例

生产态 WebUI 由 bot 进程内部托管，无需单独的 WebUI 服务。

按实例名启用：

```bash
systemctl --user enable --now llm-bot@mybot
```

### Nginx 反代

如通过 Nginx 暴露 WebUI，需关闭代理缓冲以保证 SSE 正常工作：

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

> 注意：不要为 SSE 路由设置 `Upgrade` 和 `Connection: upgrade` 头；不要手动注入 `Accept-Encoding: gzip`。

## 持久化数据

运行时数据默认存放在 `data/<instance>/`，包括：

- session transcript 与摘要
- persona 与用户资料/记忆条目
- 白名单
- 定时任务
- 好友/群申请缓存
- profile 备份文件（带轮转）

如果 `dataDir` 为默认值 `data`，运行时会自动展开为 `data/<instance>`。

## 当前限制

- 多 agent 协作能力暂未实现
- 回复以文本为主，图片等多模态输出仍不完善
- 内部 API 暂未完整暴露定时任务、白名单、请求审批的 HTTP 管理接口
- 自动化测试覆盖基础路径，端到端测试尚不完整

## License

MIT

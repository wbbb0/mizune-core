# Mizune Core

一个基于 Node.js + TypeScript 的长期运行聊天代理服务。

它可以接入 OneBot 作为消息入口，也可以完全不接 OneBot，只通过内置 WebUI 创建会话、发送消息和管理数据。项目内包含会话编排、历史压缩、reply gate、persona、用户资料、记忆持久化、工具调用、内部 API 和 WebUI。

适合的使用方式：

- 作为 QQ / OneBot 机器人的后端运行
- 作为只在本地或内网使用的 LLM 会话服务运行
- 通过 WebUI 观察会话、修改配置、编辑运行数据

## 主要功能

- OneBot 事件接入与消息发送
- Web 会话与 OneBot 会话并存
- persona、users、memory、本地持久化
- LLM 路由与工具调用
- shell、workspace、搜索、浏览器、ComfyUI 等可选能力
- 内部 API 与 WebUI 管理界面

## 环境要求

- Node.js 20+
- npm
- 至少一个可用的 LLM provider
- 如果要接 OneBot，还需要一个可用的 OneBot 实现

## 目录说明

- `src/`：后端源码
- `webui/`：Vue 3 + Vite WebUI
- `config/`：配置文件与示例
- `data/`：运行时数据，默认按实例分目录保存
- `test/`：测试
- `deploy/`：systemd 示例

## 快速开始

### 1. 安装依赖

根目录和 WebUI 需要分别安装依赖：

```bash
npm install
npm --prefix webui install
```

### 2. 准备配置文件

先从示例文件复制一份：

```bash
mkdir -p config/instances
cp config/global.example.yml config/global.yml
cp config/llm.providers.example.yml config/llm.providers.yml
cp config/llm.models.example.yml config/llm.models.yml
cp config/instances/acc1.example.yml config/instances/default.yml
```

项目启动时一定会读取一个实例配置文件。默认实例名是 `default`，因此默认必须存在：

```bash
config/instances/default.yml
```

如果这个文件不存在，程序会直接报错退出。

### 3. 填最小可运行配置

第一次跑起来，最少要把下面四类配置准备好：

1. `config/llm.providers.yml`
2. `config/llm.models.yml`
3. `config/global.yml`
4. `config/instances/default.yml`

推荐按下面的职责来放：

- `config/llm.providers.yml`
  放 provider 连接信息，例如 `type`、`apiKey`、`baseUrl`、provider feature 开关
- `config/llm.models.yml`
  放模型目录，定义每个 `modelRef` 对应哪个 provider、模型名和能力
- `config/global.yml`
  放大多数共享配置，例如 LLM 开关、会话策略、工具开关、默认超时
- `config/instances/<name>.yml`
  放某个实例自己的覆盖项，例如实例名对应的数据目录、OneBot 地址、端口、是否开启 WebUI

### 4. 先跑通 WebUI-only

如果你只是想先确认项目能工作，最简单的是先用 WebUI-only 模式，不接 OneBot。

把 `config/global.yml` 里至少改成这样：

```yml
llm:
  enabled: true
  mainRouting:
    smallModelRef:
      - qwen35_flash
    largeModelRef:
      - qwen35_plus

onebot:
  enabled: false

internalApi:
  enabled: true
  webui:
    enabled: true
```

然后把 `config/llm.providers.yml` 里的示例 provider 改成你自己实际可用的 key / baseUrl。

再确认 `config/llm.models.yml` 里被引用到的模型名确实存在，例如上面的：

- `qwen35_flash`
- `qwen35_plus`

### 5. 启动开发环境

```bash
npm run dev
```

这个命令会同时启动：

- 后端开发进程
- WebUI 的 Vite 开发服务器

如果配置里启用了 WebUI，启动后可以访问：

```text
http://127.0.0.1:<internalApi.webui.port>/webui/#/sessions
```

默认示例端口是：

```text
http://127.0.0.1:3031/webui/#/sessions
```

首次启用 WebUI 时，系统会自动生成登录口令并写入当前实例的数据目录：

```text
data/<实例名>/webui-auth.json
```

同时也会在控制台打印提示。

## 配置加载规则

项目的配置不是把所有 YAML 无差别拼在一起，而是分成两类：

### 1. 目录文件

这两份文件不是实例覆盖层，而是全局模型目录：

- `config/llm.providers.yml`
- `config/llm.models.yml`

它们定义“有哪些 provider / modelRef 可以被引用”。

### 2. 运行时配置层

真正参与运行时合并的是：

1. `config/global.yml`
2. `config/instances/<instance>.yml`

实例文件会覆盖 `global.yml` 里的同名字段。

例如：

- 共享的 `llm.timeoutMs`、`conversation`、`shell` 开关放 `global.yml`
- 某个账号独有的 `onebot.wsUrl`、`internalApi.port`、`appName` 放实例文件

### 3. 一个重要例外

`comfy` 配置只能放在 `global.yml`，放到实例文件里会被忽略。

## 实例配置怎么用

### 默认实例名

如果不传任何环境变量，实例名默认是：

```text
default
```

因此默认读取：

```text
config/instances/default.yml
```

### 指定实例名

可以通过环境变量 `CONFIG_INSTANCE` 指定实例名：

```bash
CONFIG_INSTANCE=acc1 npm run dev
```

这时程序会读取：

```text
config/instances/acc1.yml
```

### 直接指定实例配置文件

如果你不想按实例名查找，也可以直接指定文件路径：

```bash
CONFIG_INSTANCE_FILE=config/instances/acc1.yml npm run dev
```

`CONFIG_INSTANCE_FILE` 支持相对路径或绝对路径。

### `CONFIG_INSTANCE` 和 `CONFIG_INSTANCE_FILE` 的区别

- `CONFIG_INSTANCE=acc1`
  代表“实例名是 `acc1`，配置文件默认找 `config/instances/acc1.yml`”
- `CONFIG_INSTANCE_FILE=...`
  代表“直接用这个文件做实例配置”

实例名还会影响默认数据目录，因此通常更推荐用 `CONFIG_INSTANCE`。

## `global.yml` 和 `instances/*.yml` 该怎么分

可以按这个原则理解：

- `global.yml`
  放“所有实例通常共享”的行为策略
- `instances/*.yml`
  放“这个实例独有”的接入信息和运行入口

推荐这样拆：

### 放在 `global.yml`

- `llm.enabled`
- `llm.timeoutMs`
- `conversation.*`
- `shell.*`
- `browser.*`
- `workspace.*`
- `search.*`
- `scheduler.*`
- `comfy.*`

### 放在 `instances/<name>.yml`

- `appName`
- `dataDir`
- `onebot.wsUrl`
- `onebot.httpUrl`
- `onebot.accessToken`
- `internalApi.enabled`
- `internalApi.port`
- `internalApi.webui.enabled`
- `internalApi.webui.port`
- 某个实例要单独覆盖的模型引用

## `dataDir` 和实例覆盖范围

默认 `global.example.yml` 里写的是：

```yml
dataDir: data
```

当 `dataDir` 保持这个默认值时，程序会自动把它展开成：

```text
data/<实例名>
```

例如：

- 默认实例 `default` -> `data/default`
- `CONFIG_INSTANCE=acc1` -> `data/acc1`

这意味着：

- 不同实例默认各自有独立的数据目录
- 会话、persona、users、whitelist、workspace、WebUI 登录数据都会按实例隔离

如果你在实例配置里显式写：

```yml
dataDir: data/acc1
```

那就会直接使用这个路径，不再自动拼接。

## 两种常见运行方式

### WebUI-only

适合本地调试、内网使用，或者先验证模型调用和会话流程。

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

适合真正接入 QQ / OneBot 使用。

关键配置：

```yml
onebot:
  enabled: true
  wsUrl: ws://127.0.0.1:3001
  httpUrl: http://127.0.0.1:3000

internalApi:
  enabled: true
  webui:
    enabled: true

llm:
  enabled: true
```

如果 OneBot 端需要鉴权，再补：

```yml
onebot:
  accessToken: your-token
```

## 常用命令

```bash
npm run dev
npm run dev:bot
npm run dev:webui

npm run build
npm run build:bot
npm run build:webui

npm run typecheck:all
npm run test
```

如果需要 Playwright 浏览器能力：

```bash
npm run install:browsers
```

## 生产启动

先构建：

```bash
npm run build
```

再启动后端：

```bash
CONFIG_INSTANCE=acc1 npm run start:bot
```

如果 `internalApi.webui.enabled: true`，生产态会由后端直接托管构建后的 WebUI。

## systemd

`deploy/` 里提供了 service 示例。`deploy/llm-bot@.service` 使用 `%i` 作为实例名，并传给：

```text
CONFIG_INSTANCE=%i
```

例如：

```bash
systemctl --user enable --now llm-bot@acc1
```

这会启动实例 `acc1`，对应读取：

```text
config/instances/acc1.yml
```

## 持久化数据

默认每个实例的数据目录下会有这些内容：

- `sessions/`
- `persona.json`
- `users.json`
- `whitelist.json`
- `scheduled-jobs.json`
- `workspace/`
- `webui-auth.json`

## 反向代理注意事项

如果你把 WebUI 挂到 Nginx 之类的反向代理后面，需要关闭 SSE 缓冲，否则会影响会话流式更新：

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

## 提交前检查

按仓库约定，提交前至少运行：

```bash
npm run typecheck:all
npm run test
```

# 快速上手

本文档面向第一次把 Mizune Core 跑起来的配置流程。README 只保留项目入口信息，具体运行方式和配置拆分放在这里维护。

## 环境要求

- Node.js 20.19+
- npm
- 至少一个可用的 LLM provider
- 如果要接 OneBot，还需要一个可用的 OneBot 实现

## 安装依赖

根目录和 WebUI 需要分别安装依赖：

```bash
npm install
npm --prefix webui install
```

## 准备配置文件

从示例文件复制一份本地配置：

```bash
mkdir -p config/instances
cp config/global.example.yml config/global.yml
cp config/llm.providers.example.yml config/llm.providers.yml
cp config/llm.models.example.yml config/llm.models.yml
cp config/llm.routing-presets.example.yml config/llm.routing-presets.yml
cp config/instances/acc1.example.yml config/instances/default.yml
```

项目启动时一定会读取一个实例配置文件。默认实例名是 `default`，因此默认必须存在：

```text
config/instances/default.yml
```

如果这个文件不存在，程序会直接报错退出。

## 最小可运行配置

第一次运行，最少要检查这五类配置：

1. `config/llm.providers.yml`
2. `config/llm.models.yml`
3. `config/llm.routing-presets.yml`
4. `config/global.yml`
5. `config/instances/default.yml`

推荐职责如下：

- `config/llm.providers.yml`：provider 连接信息，例如 `type`、`apiKey`、`baseUrl`、provider feature 开关
- `config/llm.models.yml`：模型目录，定义每个 `modelRef` 对应哪个 provider、模型名和能力
- `config/llm.routing-presets.yml`：模型路由预设，定义不同运行角色优先使用哪些 `modelRef`
- `config/global.yml`：共享运行策略，例如 LLM 开关、会话策略、工具开关、默认超时
- `config/instances/<name>.yml`：实例覆盖项，例如数据目录、OneBot 地址、端口、是否开启 WebUI

## 先跑 WebUI-only

如果只是想先确认项目能工作，建议先用 WebUI-only 模式，不接 OneBot。

把 `config/global.yml` 至少改成这样：

```yml
llm:
  enabled: true
  routingPreset: balanced

onebot:
  enabled: false

internalApi:
  enabled: true
  webui:
    enabled: true
    auth:
      enabled: true
```

然后把 `config/llm.providers.yml` 里的示例 provider 改成自己实际可用的 key / baseUrl。

再确认：

- `config/llm.routing-presets.yml` 中存在 `balanced`
- `config/llm.models.yml` 中包含该 preset 引用到的模型
- `config/instances/default.yml` 中的端口没有和本机已有服务冲突

启动开发环境：

```bash
npm run dev
```

这个命令会同时启动后端开发进程和 WebUI 的 Vite 开发服务器。

如果配置里启用了 WebUI，启动后可以访问：

```text
http://127.0.0.1:<internalApi.webui.port>/webui/#/sessions
```

默认示例端口通常是：

```text
http://127.0.0.1:3031/webui/#/sessions
```

首次启用 WebUI 认证时，系统会自动生成登录口令并写入当前实例的数据目录：

```text
data/<实例名>/webui-auth.json
```

控制台也会打印对应提示。

## 接入 OneBot

WebUI-only 跑通后，可以再打开 OneBot：

```yml
onebot:
  enabled: true
  provider: generic
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

如果接的是 NapCat，并希望在回复生成期间显示“正在输入”，可以使用：

```yml
onebot:
  provider: napcat
  typing:
    enabled: true
    private: true
    group: false
```

其中 `typing.private` 控制私聊输入状态，`typing.group` 控制群聊输入状态。

## 配置文件职责

项目配置不是把所有 YAML 无差别拼在一起，而是分成两类。

### 目录文件

这三份文件不是实例覆盖层，而是全局目录文件：

- `config/llm.providers.yml`
- `config/llm.models.yml`
- `config/llm.routing-presets.yml`

它们定义“有哪些 provider / modelRef / routing preset 可以被引用”。

### 运行时配置层

真正参与运行时合并的是：

1. `config/global.yml`
2. `config/instances/<instance>.yml`

实例文件会覆盖 `global.yml` 里的同名字段。

推荐拆分方式：

- `global.yml`：`llm.enabled`、`llm.timeoutMs`、`conversation.*`、`shell.*`、`browser.*`、`search.*`、`scheduler.*`、`comfy.*`
- `instances/<name>.yml`：`appName`、`dataDir`、`onebot.wsUrl`、`onebot.httpUrl`、`onebot.accessToken`、`internalApi.enabled`、`internalApi.port`、`internalApi.webui.enabled`、`internalApi.webui.port`

一个重要例外：`comfy` 配置只能放在 `global.yml`，放到实例文件里会被忽略。

## 实例选择

如果不传任何环境变量，实例名默认是：

```text
default
```

因此默认读取：

```text
config/instances/default.yml
```

可以通过环境变量 `CONFIG_INSTANCE` 指定实例名：

```bash
CONFIG_INSTANCE=acc1 npm run dev
```

这时程序会读取：

```text
config/instances/acc1.yml
```

也可以直接指定实例配置文件：

```bash
CONFIG_INSTANCE_FILE=config/instances/acc1.yml npm run dev
```

`CONFIG_INSTANCE` 代表“实例名”，会影响默认数据目录；`CONFIG_INSTANCE_FILE` 代表“直接使用这个文件做实例配置”。通常更推荐使用 `CONFIG_INSTANCE`。

## dataDir 与数据隔离

默认 `global.example.yml` 中写的是：

```yml
dataDir: data
```

当 `dataDir` 保持默认值时，程序会自动把它展开成：

```text
data/<实例名>
```

例如：

- 默认实例 `default` -> `data/default`
- `CONFIG_INSTANCE=acc1` -> `data/acc1`

这意味着不同实例默认拥有独立的数据目录。会话、persona、users、whitelist、workspace、WebUI 登录数据都会按实例隔离。

如果在实例配置里显式写：

```yml
dataDir: data/acc1
```

那就会直接使用这个路径，不再自动拼接。

## WebUI 相关说明

如果希望 WebUI 仅作为内网管理面板、不要求登录，可以关闭认证：

```yml
internalApi:
  enabled: true
  webui:
    enabled: true
    auth:
      enabled: false
```

WebUI 上传附件时会在浏览器侧自动把 `HEIC / HEIF` 图片转换成 `JPEG` 后再上传，避免模型接口不兼容。

如果希望模型完整生成结束后再一次性发送，而不是边生成边按句子或段落拆分发送，可以配置：

```yml
conversation:
  outbound:
    disableStreamingSplit: true
```

OneBot 等外部投递目标仍会按 `conversation.outbound` 中的延迟参数模拟发送间隔；WebUI 投递会在形成正式分段后立即显示。

群聊中未触发回复的普通消息会作为环境消息记录，不默认进入 LLM prompt。后续有人明确 @ bot 或回复 bot 时，会按 `conversation.group.ambientRecallMessageCount` 召回最近若干条环境消息，供模型理解“刚才他们聊的内容”；设为 `0` 可关闭这段额外上下文。

## persona 初始化

如果联调其他功能时想先跳过全局 persona 初始化门槛，可以临时加上：

```yml
conversation:
  setup:
    skipPersonaInitialization: true
```

默认是 `false`。开启后仍然可以手动使用 `.setup persona` / `.config persona` 编辑 persona，只是不再阻塞会话进入正常模式。

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

`deploy/` 中提供了 service 示例。`deploy/llm-bot@.service` 使用 `%i` 作为实例名，并传给：

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
- `rp-profile.json`
- `scenario-profile.json`
- `global-profile-readiness.json`
- `setup-state.json`
- `users.json`
- `global-rules.json`
- `toolset-rules.json`
- `whitelist.json`
- `scheduled-jobs.json`
- `workspace/`
- `webui-auth.json`

如果实例目录里还有旧版 memory 数据，先显式执行一次迁移：

```bash
npm run migrate:memory -- data/<instance>
```

迁移会归并旧版 memory / rules 数据，规范化 `users.json` / `persona.json`，并生成 `memory-migration-report.json` 审计报告。

## 反向代理注意事项

如果把 WebUI 挂到 Nginx 之类的反向代理后面，需要关闭 SSE 缓冲，否则会影响会话流式更新：

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

```bash
npm run typecheck:all
npm run test
```

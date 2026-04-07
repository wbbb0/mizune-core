# webui

独立 Nuxt 管理端，负责：

- debug webui 页面
- PWA 安装入口（Chromium 与 Apple Safari 主屏安装）
- owner 使用的登录与 passkey/WebAuthn
- 浏览器到 bot internal API 的代理访问
- 从 config/instances/*.yml 自动发现可用 backend，并在页面切换
- 通过通用 editor 接口查看和编辑 config 与运行数据资源

## 安装

在仓库根目录执行：

```bash
npm --prefix webui install
```

## 开发启动

在仓库根目录直接启动：

```bash
npm run dev
```

这会同时启动 bot 开发进程和 WebUI 的 Vite 开发服务器，页面修改会实时更新。

如需单独启动 WebUI：

```bash
npm run dev:webui
```

默认会把 Vite 开发服务器绑定到实例配置里的 `internalApi.webui.port`，并监听 `0.0.0.0`。开发态与生产态都继续服从 `internalApi.webui.enabled` 和 `internalApi.webui.port`。

如果开发态需要通过反代域名访问，还要在 `internalApi.webui.allowedHosts` 中显式放行对应 host。

开发态下，bot internal API 会回退到 `internalApi.port`，Vite 再把 `/api` 代理过去；生产态则仍由 bot 自己在 `internalApi.webui.port` 上托管构建后的 WebUI 静态产物。

例如 `CONFIG_INSTANCE=dev` 时：

- 页面地址：`http://127.0.0.1:3131/webui/#/sessions`
- API 代理目标：`http://127.0.0.1:3130`

backend 清单默认直接读取仓库下的 `config/instances/*.yml`（排除 `.example.yml`），并为每个 `internalApi.enabled: true` 的实例生成一个管理端入口：

- backend id：实例文件名，例如 `acc1.yml -> acc1`
- 显示名称：优先取 `appName`，否则回退到实例名
- 管理地址：默认拼成 `http://127.0.0.1:<internalApi.port>`

如需手动覆盖 internal API 代理目标，可在启动 webui 时覆盖：

```bash
VITE_API_TARGET=http://127.0.0.1:3130 npm run dev:webui
```

如需修改 Vite 开发服务器自己的页面端口，可在启动 webui 时覆盖：

```bash
VITE_DEV_PORT=5174 npm run dev:webui
```

## 反向代理注意事项

如果通过 Nginx / HTTPS 反向代理访问 WebUI，需要分别注意 SSE 和开发态 HMR 两类连接：

- SSE 不能被代理层缓冲。否则空 private 会话这种只会立即返回一个很小 `ready` 首包的流，可能长时间卡在 `connecting`；而 group 会话因为初始 transcript 很大，表面上又像是正常的。
- 开发模式下如果页面是通过反代域名访问，Vite 的 HMR 还依赖 WebSocket；如果反代没有正确透传 `Upgrade` / `Connection`，页面虽然能打开，但改动不会实时热更新，浏览器控制台通常会出现 `failed to connect to websocket`。

SSE 至少建议配置：

- `proxy_http_version 1.1`
- `proxy_buffering off`
- `proxy_request_buffering off`
- `proxy_cache off`
- `gzip off`
- 不要为 SSE 路由设置 `Upgrade` / `Connection upgrade`
- 不要手动设置 `Accept-Encoding gzip`

示例：

```nginx
location / {
	proxy_pass http://192.168.0.33:3131;

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

如果是开发态反代到 Vite，还需要允许 WebSocket 升级。可以使用：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 33331 ssl http2;
    server_name home.wabebabo.cn;

    location / {
        proxy_pass http://192.168.0.33:3131;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        gzip off;

        add_header X-Accel-Buffering no always;
    }
}
```

如果只在本机开发，也可以直接访问 `http://127.0.0.1:<internalApi.webui.port>/webui/#/sessions`，绕过 HTTPS 反代，这样最容易确认热更新问题是否来自代理层。

## 生产构建

```bash
npm run build:webui
```

## 页面能力

- `Sessions`：查看基于 transcript 派生的聊天消息与完整后台记录，并发送调试消息
- `Sessions` 聊天区会直接显示由 `send_workspace_media_to_chat` 发送出的 workspace 图片，并支持简单放大预览
- `Config`：编辑配置层的 instance 覆盖
- `Data`：查看和编辑常见运行数据 JSON，例如 persona、users、whitelist、scheduled jobs
- `Workspace`：浏览 workspace 文件树与资产列表，并对图片与文本文件做只读预览
- `Backends`：切换当前代理到的 backend 实例

### Sessions 页展示规则

- 聊天页只展示真正发到 OneBot 的消息：
  - 用户消息
  - 助手文本回复
  - 工具实际发送出去的图片消息
- 后台记录页展示完整 transcript，包括工具调用、工具结果、门限判定、系统状态、direct command 等非聊天条目。
- `send_workspace_media_to_chat` 发图片时只允许纯图片发送；如果模型还要附带文字，必须单独发送普通助手回复。
- 聊天页与后台记录页的“重新加载”都会从头重拉 transcript，不再依赖本地缓存。

## PWA 说明

- Chromium 浏览器可直接安装为桌面或移动端应用
- Apple Safari 可通过“添加到主屏幕”安装
- 页面路由使用 hash 模式，安装后的 PWA 在内部切换 `Sessions / Config / Data / Workspace / Settings` 时不会再触发浏览器级外部页面跳转
- 当前只提供基础安装能力，不承诺离线可用，运行时 `/api/**` 数据不会被离线缓存

## Passkey TODO

目前还未实现登录与 passkey，后续按 owner-only 场景推进。

### 第一阶段

- 增加单 owner 密码登录
- 登录成功后签发 httpOnly session cookie
- 所有页面路由、server api 代理路由、SSE 握手统一校验 cookie

### 第二阶段

- 在已登录 owner 会话内注册 passkey
- 登录页支持“密码登录”或“passkey 登录”
- passkey 验证成功后仍然落到同一套 session cookie

### 具体方案

- 不引入多账号系统，webui 只有一个 owner 身份
- passkey 注册必须在已登录状态下完成，不开放匿名注册
- 服务端保存 WebAuthn challenge、credentialId、publicKey、counter、transports、创建时间和备注名称
- WebAuthn 校验逻辑放在 webui server 层，不下沉到 bot internal API
- backend 清单继续由服务端扫描 config/instances 生成，不允许页面手工编辑管理端地址

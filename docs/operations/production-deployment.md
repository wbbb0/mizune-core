# 正式部署

正式实例使用仓库内的 `.deploy/` 保存不可变 Release，不直接运行开发构建目录中的 `dist/` 或 `webui/dist/`。

## 目录边界

- `dist/`、`webui/dist/`：开发和构建暂存产物，可以被构建命令清理。
- `.deploy/releases/`：正式 Release，每个目录创建后不再原地修改。
- `.deploy/current`：所有正式实例共同使用的当前 Release。
- `.deploy/previous`：上一个 Release，用于无数据迁移发布的失败恢复。
- `.deploy/dependencies/`：按 lockfile、平台、架构和 Node ABI 隔离的生产依赖。
- `.deploy/web-assets/`：保留中 Release 共享的哈希 WebUI 资源。
- `config/production.yml`：本机正式实例清单，不纳入版本控制。

开发实例不得写入 `config/production.yml`。部署脚本不会扫描 `config/instances/` 猜测哪些实例属于正式环境。

## 配置

从 `config/production.example.yml` 创建本机配置：

```yaml
instances:
  - name: acc1
    healthUrl: http://127.0.0.1:3231/healthz
    # 省略时保留当前 systemd enable 状态。
    # enableOnBoot: true

retainReleases: 3
healthTimeoutMs: 30000
```

健康检查只要求应用、内部 API 和 WebUI 当前 Release 正常，不要求 OneBot/NapCat 已连接。

## 执行部署

正常正式部署要求工作区干净：

```bash
npm run deploy:production
```

如果某个正式实例已经存在自定义的实例专属 unit（例如
`~/.config/systemd/user/llm-bot@acc1.service`），确认要接管时显式使用：

```bash
npm run deploy:production -- --adopt-unit
```

确实需要发布当前未提交快照时，部署脚本会复制受 Git 管理及未忽略的源码到隔离构建目录，并记录 dirty diff 摘要：

```bash
npm run deploy:production -- --allow-dirty
```

不要把 `--skip-checks` 用于正常正式部署；它只用于已经在同一源码快照上完成完整验证后的恢复操作。

部署脚本会：

1. 使用内核文件锁阻止并发部署。
2. 在隔离 worktree 或源码快照中完成类型检查、测试和构建。
3. 创建生产依赖快照并加载原生模块做 smoke。
4. 校验 WebUI 入口与 Service Worker 引用闭包。
5. 创建不可变 Release 和校验和。
6. 为清单中的每个正式实例事务性更新 `.deploy/current` 与实例专属 unit。
7. 批量重启 `config/production.yml` 声明的全部实例。
8. 验证 MainPID、release ID、WebUI 入口、脚本 MIME、manifest 和缺失脚本 404。
9. 成功后清理无引用的旧 Release、依赖和哈希资源。

首次迁移会先把当前根目录产物保存为 `legacy-*` Release。新 Release 验证失败时会恢复旧 Release、实例专属 unit、active 状态和 enable 状态。部署进程异常退出或机器断电后，下次部署会先恢复未完成的激活事务，再创建新 Release。

## 回滚边界

自动恢复只覆盖代码、WebUI、依赖、systemd unit 和 enable 状态，不自动恢复 `data/` 或正式配置。

如果发布包含持久化 schema 或不可逆数据迁移，必须在部署前单独备份，并确认旧版本是否能读取新数据。无法证明兼容时，不应把切回旧 Release 当作可靠的数据回滚方案。

## systemd 与 NapCat

正式 unit 不依赖 `napcat@%i.service`，也不依赖 `network-online.target`。llm-bot 实例名与 NapCat 实例名没有固定映射；外部连接不可用时由应用运行时自行重连。

部署脚本不会覆盖共享的 `llm-bot@.service` 模板，只为 `config/production.yml` 中的实例写入 `llm-bot@<实例>.service` 精确 unit。因而 `llm-bot@dev.service` 和其他未列入清单的实例不会迁移、重启或改变下次启动行为。实例专属 unit 已存在时，脚本只覆盖带项目托管标记的文件；首次接管其他文件需要 `--adopt-unit`，用户自定义 drop-in 不会被删除。

公网反向代理只需继续把整站转发到内部 API 端口，不需要增加静态文件规则或额外本地 Nginx。

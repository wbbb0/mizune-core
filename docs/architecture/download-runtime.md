# 下载运行时

下载能力由两层组成：

- `vendor/node-http-download-engine` 只负责 HTTP 传输，包括 SSRF 防护、DNS 固定、重定向校验、Range 分段、重试、进度和 checkpoint。
- `DownloadRuntime` 负责任务生命周期、代理配置选择、文件大小上限、暂停/恢复/取消、后台回调，以及完成后登记到 `ChatFileStore`。

下载引擎以 Git submodule 引入。初始化源码仓库后必须运行：

```bash
git submodule update --init --recursive
```

## 工具边界

下载工具位于 `asset_io` 工具集：

- `start_download_resource`：从明确的 HTTP/HTTPS URL 创建任务。
- `list_live_resources(type=download)`：列出下载资源。
- `read_download_resource`：读取状态。
- `pause_download_resource` / `resume_download_resource`：暂停和 checkpoint 续传。
- `cancel_download_resource`：取消任务并清理临时文件。

通用 URL 下载使用 `url_download` asset origin。浏览器资源和群文件仍通过各自已有工具进入同一个 `DownloadRuntime`，完成后统一返回 asset handle。

普通 URL 默认采用浏览器代理配置，也可以显式直连。下载目标只允许 HTTP/HTTPS；引擎默认阻止私网、环回、链路本地和其他危险地址，配置的 HTTP/HTTPS 代理视为受信任基础设施。任务在传输前先探测远端大小，并在传输进度中继续执行 `chatFiles.maxUploadBytes` 上限检查。

## WebUI 与生命周期

WebUI 的“资源 → 下载任务”通过 `/api/downloads` 管理同一批运行时任务，可创建、查看、暂停、恢复、取消和移除。运行中的任务每秒刷新进度。

下载任务当前属于进程内 live resource：已结束任务最多保留 50 个或 30 分钟；服务重启会清理临时文件和任务列表。checkpoint 用于同一进程内的暂停/恢复，不是持久任务队列。需要跨重启续传时，应在宿主层新增 SQLite 任务存储并持久化引擎 checkpoint，而不是把队列逻辑放入通用下载引擎。

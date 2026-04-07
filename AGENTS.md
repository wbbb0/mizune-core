# AGENTS.md

## 项目定位

这是一个基于 Node.js/TypeScript 的 LLM 聊天代理服务，当前可接入 OneBot，也支持仅通过 WebUI 操作，核心能力包括：

- OneBot 事件接入与消息发送
- 会话编排、历史压缩、回复门控与发送队列
- persona、用户资料与记忆持久化
- unified shell tools (shell_run, shell_interact, etc.) with timeout-to-background and PTY support
- 定时任务、白名单、请求审批与内部 API
- WebUI（Vue 3 + Tailwind）：会话监控、配置编辑器、数据编辑器

## 仓库结构

### 根目录

- `src/`：主源码目录
- `webui/`：WebUI 前端（Vue 3 + Tailwind + Vite）
- `test/`：回归测试与测试辅助代码
- `config/`：运行时配置与示例配置
- `data/`：本地运行时数据、缓存、会话与持久化文件
- `deploy/`：systemd 服务示例
- `README.md`：项目说明与运行方式
- `package.json`：脚本、依赖与 Node 版本要求
- `tsconfig.json`：TypeScript 编译配置

### src/

- `index.ts`：应用入口
- `logger.ts`：日志配置
- `app/`：应用编排相关逻辑
  - `bootstrap/`：启动流程
  - `generatrion/`：生成流程相关逻辑
  - `messaging/`：消息链路编排
  - `runtime/`：运行时装配
  - `session-work/`：会话工作流
- `bot/`：OneBot 客户端、事件路由、消息 ID 与类型定义
- `config/`：配置模型、Schema、加载与管理
- `conversation/`：会话、debounce、压缩、reply gate 等能力
- `data/`：数据访问与持久化抽象
- `forwards/`：合并转发相关处理
- `identity/`：身份与主体信息处理
- `images/`：图片资产与图像相关处理
- `llm/`：模型接入、prompt、工具注册与调用链路
- `memory/`：记忆数据结构与管理逻辑
- `messages/`：消息段解析、规范化与格式处理
- `persona/`：persona 配置、Schema 与存储
- `proxy/`：代理相关能力
- `requests/`：好友/群申请缓存与审批逻辑
- `runtime/`：运行时上下文与共享能力
- `search/`：搜索与网页浏览能力
- `shell/`：shell、作业、tmux 相关能力
- `internalApi/`：内部 HTTP API 服务（Fastify）、路由与 WebUI 托管
- `types/`：共享类型定义
- `utils/`：通用工具函数

### test/

- 按功能模块组织的回归测试，例如配置、记忆、shell、reply gate、session 持久化等
- `helpers/`：测试辅助代码
- `run-all-tests.mjs`：测试入口脚本

### config/

- `global.example.yml`：完整示例配置模板
- `global.yml`：本地实际运行配置
- `instances/`：多实例覆盖配置

### data/

- `data/<instance>/`：实例运行数据
- 常见内容包括 session、persona、users、whitelist、scheduled jobs、缓存与备份

## 开发约束

### 0. 代码质量第一原则

本项目的第一要求是不堆屎山，始终优先保持结构清晰、功能分割明确、代码可读、可维护。

这意味着默认应遵循以下原则：

- 优先做职责清晰的拆分，而不是把新逻辑继续堆进已有混杂模块
- 优先消除隐式耦合、散落分支和特例硬编码，而不是继续在原位置打补丁
- 优先让配置、运行时能力、数据结构、调用链边界保持一致
- 优先选择长期可维护的清晰结构，而不是“先凑合能跑”的短期方案
- 发现现有设计已经开始堆积复杂度时，应主动整理结构，而不是容忍复杂度继续扩散

### 1. 默认不保留向后兼容代码

当项目功能、配置结构、数据结构、模块边界发生变更时，默认直接收敛到新实现，不为了兼容旧行为额外保留过渡层，除非任务明确要求兼容旧版本。

这意味着默认可以直接做以下事情：

- 删除旧分支、旧参数、旧字段、旧工具别名
- 删除仅为兼容旧配置/旧数据格式存在的适配逻辑
- 删除废弃的迁移兜底、兼容性 fallback、双写/双读代码
- 直接更新调用方、测试、文档，使其以当前设计为准

### 2. 变更优先级

实现功能变更时，优先保证以下几点：

- 新结构清晰且单一
- 代码路径可维护，不堆叠兼容判断
- 测试覆盖当前行为，而不是继续验证已废弃行为
- README、配置示例、测试数据与实现保持一致
- 接受必要的大规模重构，但重构后结构必须更整洁、更单一，而不是把复杂度转移到别处

### 3. 兼容性例外

只有在以下情况，才保留或新增兼容层：

- 任务说明明确要求向后兼容
- 明确要求保留旧配置或旧数据迁移能力
- 明确要求保留外部接口协议兼容性

如果没有这些明确要求，就不要主动添加兼容代码。

## 修改建议

- 修改功能时，优先检查 `src/` 中的真实调用链，而不是围绕旧行为叠加补丁
- 修改配置或持久化结构时，同时更新 `README.md`、`config/*.yml` 示例和相关测试
- 做破坏兼容性的重构时，需要同步更新或删除 `config` 中已经过时的旧配置结构，不要保留失效字段或旧写法
- 修改行为后，删除无效旧实现，避免留下“以后也许会用”的死代码
- 如果修改了会话消息清单、发送队列、transcript 类型、SSE 会话流或其他会直接影响 WebUI `Sessions` 页展示语义的后端逻辑，必须同步更新前端会话页与相关文档，不要只改后端数据链路
- `webui/` 前端默认优先使用 Tailwind utility class；只有全局主题变量、浏览器基础样式和少量 utility 难以表达的场景才写 CSS
- `dist/` 和 `node_modules/` 属于产物或依赖，不作为源码修改目标
- 准备提交 commit 前，必须至少跑通 `npm run typecheck:all` 和 `npm run test`

## Prompt 语言约定

- 本项目中的所有 prompt 默认使用中文编写，包括 system prompt、developer prompt、tool prompt、总结提示词、压缩提示词、persona 相关提示词及其他内部提示文本
- 除非任务明确要求使用其他语言，或外部接口协议明确要求特定语言，否则不要使用英文或中英混写 prompt
- 修改或新增 prompt 时，同时检查相关测试、示例配置与文档描述是否仍与中文 prompt 约定一致

如果仓库中的现状与本文档描述不一致，以实际代码结构为准，并同步更新本文件。

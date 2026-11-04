# 编辑器 Schema 元数据约定

本文档整理配置编辑器与数据编辑器当前采用的 schema 元数据展示规则，重点说明 `title` 与 `description` 的职责边界，以及后端导出和前端展示之间的契约。

## 目标

编辑器元数据的核心目标不是“把字段全部翻译一遍”，而是让维护者和使用者能稳定理解字段含义。

当前长期约定：

- `title` 负责展示名称
- `description` 负责补充解释
- 中文文案优先准确、稳定、可维护
- 不为了旧命名长期保留兼容层

## `title` 与 `description` 的职责

### `title`

`title` 只承担“名称”职责：

- 页面主标签、分组名、字段名优先显示 `title`
- 名称应尽量短、稳定、可扫描
- 不把操作说明、警告或大段解释塞进 `title`

### `description`

`description` 只承担“解释”职责：

- 用于补充字段语义、边界或注意事项
- 只在确有必要时提供
- 不要求每个字段都写说明
- 当前前端主要将其作为 hover / 提示信息消费

## 命名规则

当前约定的命名方向如下：

- 对象 / 分组节点
  - 使用稳定的领域名称，便于快速识别模块边界
- 基础字段
  - 优先使用业务语义明确的中文名，而不是机械照搬 key
- 数组 / 记录项
  - 说明集合本身的语义，必要时再补充单项说明

不推荐的做法：

- 同一类字段在不同资源里使用不同中文口径
- 为了“显得丰富”写大量不提供新信息的说明
- 让名称和解释互相重复

## 后端与前端的边界

当前契约如下：

- 后端 schema / editor service 负责导出元数据，配置编辑接口通过 `schema.meta` 传输
- 前端编辑器根据 `schemaMeta` 决定显示名称与提示说明
- 不在前端再做一层自动翻译或额外兼容映射

这意味着：

- 新增 schema 时应优先在后端元数据层补齐 `title` / `description`
- 前端默认消费既有契约，而不是自行猜测字段中文名

相关实现入口：

- `src/internalApi/application/editorService.ts`
- `vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaNode.vue`
- `vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaField.vue`
- `webui/src/api/editor.ts`
- `src/data/schema/`

## 展示约定

当前展示语义应保持一致：

- 名称来自 `title`
- 解释来自 `description`
- 当 `title` 缺失时才允许退回 key
- `description` 是补充信息，不应喧宾夺主

## 验证建议

修改 schema 元数据时，至少应覆盖以下验证层面：

- schema 元数据导出是否符合预期
- internal API 返回的 editor 资源是否带出正确字段
- WebUI 编辑器展示是否按照 `title` / `description` 契约渲染

如果未来继续扩展编辑器资源，默认沿用这套元数据口径，而不是在不同资源类型之间重新发明命名规则。

## 配置编辑接口的传输与缓存

`GET /api/editors/:resource` 将静态结构和当前配置值分开返回：

- `schemaVersion` 是 `schema` 描述的 SHA-256 内容版本。
- 首次加载返回 `schema: { meta, template, defaultValue }`；服务端在 editor service 生命周期内复用这份描述。
- 前端缓存对应资源的描述，后续加载携带 `?schemaVersion=<已缓存版本>`。只有版本相符时，响应才省略 `schema`；服务重启或发布造成结构变化时会自动重新下发。
- `editor` 始终返回最新配置值、继承关系、编辑功能和文件 revision。Schema 版本不能代替 LLM 目录的文件 revision，也不能跳过保存事务的冲突检查。

`webui/src/api/editorModelLoader.ts` 在传输边界调用共享的 `buildUiTreeFromMeta`，在内存中构建并复用 UI 树，再还原组件库需要的完整 `EditorModel`。接口不再序列化 UI 树中每层重复引用的元数据；Schema 和 UI 树标记为非响应式结构，配置草稿仍保持响应式。

保存成功后仍会重新读取后端结果，以取得规范化配置和最新文件 revision。这次读取复用已知 Schema，只传当前配置状态，不再重复下载整个 UI 树。缓存仅存在于当前页面内存，不写入 localStorage 或持久化缓存。

## 判别联合的参数继承

分层配置中的联合类型按本地值、有效值、继承值、默认值依次解析判别字段。实例只覆盖启用状态或内层参数时，表单继续显示继承的供应商，不会回退到第一个选项。

对供应商专属参数，后端可通过可选 `editorFeatures.variantInheritance` 声明参数归属路径、判别字段、参数字段和各分支默认值。编辑器据此隔离跨分支的继承参数，保持草稿预览与后端合并语义一致；未声明该功能的编辑器保留通常的深合并行为。内容安全在 `contentSafety` 路径声明 `provider` 控制 `config` 的归属。

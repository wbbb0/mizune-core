# 三层角色与分块初始化

固定档案以 `character.sqlite` 中的 `character_documents` 为唯一数据源，按实例共享。`persona` 用于所有模式，`social` 只用于 RP 模式，`embodiment` 只用于沉浸模式。普通 assistant 不读取社交设定或身体信息。通用昵称组件可以读取基础人格的轻量视图，不另存档案副本。

Schema 位于 `src/character/schemas`。旧版 persona/RP 与混合固定信息的 stateful_rp 状态不迁移，也不用于新角色提示词。实现不会主动删除旧运行文件。

## 确认流程

全新沉浸会话依次进入 `persona → social → embodiment → state`，每个阶段用 `.confirm` 发布。已确认的全局层不因内容留空而再次初始化；新会话只初始化自己的状态。普通 RP 的社交状态按会话维护，不要求额外的具身开局步骤。

`.setup <阶段>` 从空草稿开始，`.config <阶段>` 从当前值开始，`.cancel` 放弃当前草稿。配置时修改只落草稿；未确认前不会改变其他会话。全局发布采用 revision 检查，其他会话先发布时拒绝覆盖旧草稿。普通游玩和 OOC 只能修改动态状态。

模型应尽量推荐并填写，但用户可以留空确认。空值不是无边界或禁用。缺少运行参数的机制不运行。系统填充的空结构与用户已触及的分块分开记录。有效 ID、正确类型与引用仍须满足；衣物 ID 可由系统生成。

各阶段复用 `send_setup_draft` 供 owner 核对。工具直接读取当前持久化草稿，按现有 Schema 格式化本阶段全部分块、集合条目和完整文本（包括参考图长描述），不混入已确认的其他层，也不把模型传入的 `content` 当作草稿替代品；`content` 仅追加补充说明。发送不发布或修改草稿，仍须用户 `.confirm`。工具暴露与执行边界使用同一阶段工具集；草稿取消、替换、内容变化、阶段切换或会话清空后，排队中的旧草稿不再投递。已实际投递的消息仍记录真实历史及回执，只有会话清空或重建才阻止迟到记录回写。

进入配置、新建 Web 会话触发强制配置、确认后进入下一阶段时，系统排入一次模型引导。引导认领状态持久化，刷新、重连和读取目录不会反复触发。模型失败不发布草稿，用户可继续对话。

## Data 页面编辑固定设定

Data 的「三层角色档案」使用 workbench-kit 的 Schema 树形编辑器，按基础人格、社交设定、具身设定分组。编辑内容保留为页面本地草稿；验证不发布，放弃修改恢复最后读取值，点击保存才发布。保存会确认有实际改动的设定层，未改动的未确认层仍继续聊天初始化；要留空确认某层时使用聊天中的 `.confirm`。

编辑树由现有角色 JSON Schema 生成，不包含 `revision` 和 `confirmed` 等系统字段。保存仍通过角色仓库执行完整字段和跨字段校验，检查读取时的 revision；过期提交和对确认状态的直接修改会被拒绝。错误不会清除页面草稿。Data 发布与聊天确认共享固定档案 revision，旧聊天草稿需要取消后重新进入配置。已有会话动态状态、衣物实例和快照不由此重建。

## 分块接口

- `list_character_sections` 只返回目录、当前阶段、草稿 ID 和进度（包含当前阶段可写分块与已确认前置固定层的只读分块）。
- `read_character_section` 返回指定块的值、中文说明和完整局部 Schema；带 `collectionKey` 的集合分块支持传可选 `itemId` 单条读取。配置阶段允许只读访问已确认的前置固定设定层（如在 `embodiment` 或 `state` 阶段只读已确认的 `persona`、`social`），但只读分块不展开编辑/跳过工具且拒绝写入或跳过。
- 配置阶段按当前分块展开专用填写工具，草稿与分块由工具名称绑定；普通游玩仍使用 `edit_character_section` 修改动态状态。

分块采用 `persona.name`、`social.identity`、`social.referenceImages`、`embodiment.physiology.menstrualCycle`、`embodiment.wardrobe.items` 等自然路径。会话状态使用 `session.social.*`、`session.simulation.*`。集合按单条 ID 编辑，禁止整体提交非空集合。未知路径、额外字段、非法数值或不存在的引用会被拒绝。

## 角色设定图与外貌辅助（`social.referenceImages`）

`social.referenceImages` 保存角色视觉参考资料（最多 8 条），每条记录包含 `id`（`ref_1` 等）、`fileId`（静态图片资产 ID）、`label`、`subject`（多人图中的目标主体说明，单人图为 `null`）与 `description`（完整中文视觉特征描述）：

- **导入与精读**：在 `social` 配置阶段且资产库与图片精读启用时，向 owner 暴露 `import_character_reference`。工具解析 `asset_ref` 或 `file_id`，复用 `mediaVisionService` 与 `mediaInspectionService` 提取详细视觉描述并写入当前 `social` 草稿。仅当上游完成状态非截断（`completionStatus !== "truncated"`）、JSON 未经 `jsonrepair` 修补（`parseStatus === "parsed"`）、顶层协议字段齐全且 `status === "answered"`、`found === true` 时才写入草稿；已知的政策或协议异常由 Provider 明确返回失败，不降为 `unknown`。缺少可靠结束信息时保留 `unknown` 并在回执注明限制；多人图目标不明确时返回 `uncertain` 由用户澄清。
- **来源不可变与统一校验**：已存条目的来源字段 `fileId`、`subject` 属于不可变身份字段，专用修改工具不暴露这两个参数，所有写入入口（导入工具、集合工具、`edit_character_section`、HTTP 分块接口、Data 保存与 `.confirm`）均通过统一的资产校验、临时保留（retain lease）与提交流程校验静态图片资产存在性及来源字段不可变。
- **异步写入与确认**：`src/character/writes.ts` 统一处理资产准备、取消及操作有效性检查；仓库在短事务内检查预期草稿或条目快照后提交。确认期间取消重建或修改草稿都会拒绝发布，读取引导状态和标记进度不改变确认内容。集合的新增、局部修改、删除分别执行，局部字段在事务内合并；校验期间条目被修改或删除时报告冲突，不覆盖新值或恢复已删除条目。生成取消或会话模式变化后不提交待完成写入。
- **轻量上下文投影**：`characterPrompt`（含配置阶段已确认社交设定与普通游玩）及 `StatefulRpPostTurnMaintainer` 在构造模型上下文时仅投影 `{ id, fileId, label, subject }`，不将长 `description` 拼入每轮常驻上下文；需要完整文字描述时按需调用 `read_character_section`（可传 `itemId`），需要生图、看图或发图时将 `fileId` 传给 `generate_image`（`reference_images`）、`asset_media_view` / `asset_media_inspect` 或 `asset_send_to_chat`。
- **资产保留与回收边界**：`characterReferencedFileIds` 只枚举已发布 `profile` 和所有会话 `social` 草稿中的持久引用，由装配层注入 `ChatFileStore` 与 `AssetLifecycleService`。临时保留计数只归资产库，所有实际删除经过同一边界检查，引用读取失败时拒绝删除。被引用图片在会话清理、TTL/容量回收、文件删除与 Data `workspace_files` 删除时均受保护；取消草稿或移除条目后恢复正常回收。角色写入需要明确装配资产依赖，不直接读取资产数据库或猜测文件路径。
- **Data 页面展示**：Data 的 `character_profile` 资源下展示 `social.referenceImages` 列表，已存条目的 `fileId`、`subject` 只读展示并提供受鉴权的 `/api/chat-files/:fileId/content` 原图预览与打开链接，支持编辑 `label`、`description` 与删除条目。

固定配置确认后，下一轮读取新设定，不重写既有剧情。衣柜模板只决定新开局的实例；实例保存定义副本，后来修改或删除全局模板不影响已有衣物。关闭周期机制会清除相应活动状态，其余动态信息保留。

## 代码周期

本次标准计算仅实现 `menstrualCycle`：

- `cycleDays`：开始到下一次开始的基准游戏日数。
- `maxVariationDays`：每轮均匀抽取 `[-n, n]` 的整数偏移，0 表示固定。
- `durationDays`：持续游戏日数，结束日不包含在内。
- 会话初始化提供 `lastStartDate`。运行时保存 `nextStartDate`、`currentEndDate` 和 `active`，模型不能修改这些派生值。

使用会话时钟与 IANA 时区，不按现实等待时间推进。随机结果与状态一起持久化，读取和读档不重抽。时间跨越多轮时逐轮结算，事件按 ID 记录并保留近期 40 条。日期校正使用 `.config state`；普通游玩不允许时钟倒退。修改参数保留当前结束日期，仅重排未来开始；未提供必要参数或上次日期时暂停计算。

主回复模型和后置维护模型读取相同的代码事件，不为通知单独调用模型。其他生理机制可留空、关闭或使用叙事规则；未实现的 `standard` 机制明确拒绝，不能伪装成已经支持计算。

后台维护先估计本轮经过的时间，再按阈值更新有限的动态分块。任何一项失败都不提交半成品。提交前再次检查会话 revision、角色 revision 和取消状态，防止覆盖玩家修改、重置或读档。

## WebUI 动态状态展示

会话的「RP 状态」页用于只读查看动态状态，使用 workbench-kit 的页头、操作按钮、卡片、键值详情、折叠区与集合表格。概览与近期事件优先展示，社交、场景、身体、心理、关系、衣柜、日程等内容按当前 Schema 分区展示。加载、错误、无状态与尚未确认开局分别提示。刷新、会话回到空闲、状态变更和读档后重新读取；过期请求不能覆盖切换后的会话。

## 会话存档

WebUI 的 Scenario 与 RP 状态面板共用存档入口。快照保存聊天及该模式的动态状态，读档后刷新状态展示；固定角色档案仍使用实例当前已确认配置，不随会话快照回退。配置阶段必须先确认或取消，才能存档、读档或复制会话。

## 初始化工具的分块编辑协议

初始化及配置草稿中使用稳定的分块专用工具，例如 `setup_fill_persona_name`。每个配置阶段的全部分块编辑工具直接可用，无需通过工具集接口申请加载，也不维护已加载分组缓存。查询目录或读取分块没有切换工具的副作用，修改无需先读取。

执行端绑定生成轮次开始时的草稿 ID，取消重建或确认换阶段后拒绝旧轮次调用。工具名称不携带草稿标识，参数也无需传草稿 ID。工具集可用范围与执行权限一致，其他阶段的工具不能通过自行构造调用绕过。

单字段工具直接使用业务字段，例如 `{ "name": "小满" }`；对象分块把字段展开到参数顶层。对象局部修改，省略字段保留原值，显式 `null` 清空可空字段，普通数组整体替换。可空对象通过独立清空工具置为 `null`。模型不需要传 `action`、`value`、分块 ID 或草稿 ID。

带 ID 集合分别提供新增、修改、删除工具，每次处理一条。独立记录的新增 ID 由系统生成；参与者 ID 和穿戴记录的实例 ID 属于业务引用，新增时必须明确填写，不能随机生成。修改和删除使用已有 `itemId`，不能改写记录 ID。跳过工具不需要参数，仅标记已处理并保留当前值。周期派生值和时钟计数器不进入可编辑 Schema。成功回执只包含结果、修改字段和必要条目 ID，不回显完整档案。owner 权限与用户 `.confirm` 发布要求保持不变。

初始化工具递归检查所有字符串值：完整内容能够解析为 JSON 对象或数组时拒绝整次调用；完整 JSON 代码块也检测。不自动解码、提取或猜测。数字文本、布尔文本、`null` 文本和夹带 JSON 示例的普通叙述不因此被拒绝。参数错误返回具体字段路径、原因及当前 Schema，同轮相同参数错误不重复执行；读取状态或改正输入后可以继续。

Scenario 初始化/配置工具使用同一输入校验与纠错规则。Scenario 资料修改直接使用 `theme` 等顶层字段，不使用 `profilePatch` 包装；既有玩家/NPC 归属和确认条件不变。普通游玩不应用此字符串规则。

工具目录按当前阶段展开全部稳定的分块工具。这一调整不改变持久化格式，无需迁移既有角色或草稿，也不会自动清洗已有内容。

## 配置阶段的辅助工具

初始化和资料草稿编辑复用现有工具集。工具目录通过 `availableDuringSetup` 声明额外开放的 `asset_io`、`filesystem_io`、`web_research`、`conversation_navigation`、`image_generation`、`comfy_image`，与通用工具集一起在配置阶段开放。身份权限、功能开关和会话显式禁用的辅助工具集仍然有效，阶段专属草稿工具继续由 setup override 决定。正常游玩阶段的默认工具集不受此标记影响。

这些是完整的现有工具集，不代表只读权限。WebUI 上传附件已经登记，应通过 `asset_document_*` 等工具读取，无需调用 OneBot 文件下载工具。

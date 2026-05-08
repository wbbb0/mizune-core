# 文档文件工具与命名设计

## 背景

当前文件相关工具有两组命名：

- `local_file_*`：面向本地文件系统，按路径读写、搜索、发送；相对路径以 `localFiles.root` 为基准，绝对路径按进程权限访问。
- `chat_file_*`：面向已登记到 `ChatFileStore` 的文件资源，按 `file_id/file_ref` 查找、查看媒体、发送。

这两个名字能表达当前来源，但不适合作为长期命名：

- `local_file` 没有表达清楚权限边界。当前 `LocalFileService` 对相对路径限制在 `localFiles.root`，但对绝对路径会直接解析并访问；因此它在工具启用且进程权限允许时，实际可以访问整个本机文件系统。
- `chat_file` 已不准确；登记文件来源已经包括聊天附件、WebUI 上传、浏览器下载/截图、ComfyUI 生成、本地导入等，不只是聊天文件。
- 文档能力会扩展出 view/search/read/inspect/summarize 等子操作，如果继续使用 `chat_file_document_*`，会继续放大 `chat_file` 这个历史名称。

本文只评估命名与文档工具结构，不涉及代码改动。后续应等文件获取落地分支完成后，再基于新的文件登记/获取能力实施。

## 命名目标

工具名应满足：

1. 顶层前缀是一个稳定单词，便于模型和用户理解。
2. 同一资源域的工具在工具列表中自然聚集。
3. 能清楚区分“路径文件”和“已登记资源”。
4. 能继续扩展媒体、文档、音频等子能力。
5. 默认不长期保留旧工具别名；迁移时一次性更新提示词、toolset、测试和 observation 文案。

## 顶层命名建议

### `local_file` -> `filesystem` 或先收紧为 `workspace`

当前实现更接近 `filesystem`，不是 `workspace`。原因是 `localFiles.root` 只约束相对路径字面量；绝对路径会直接按进程权限访问。

还需要注意：相对路径限制目前不是完整的真实文件系统边界。实现没有对最终路径做 `realpath` 校验，root 内符号链接可能指向 root 外。也就是说当前边界应描述为“路径字面量不能 `..` 逃逸 root”，而不是“所有实际 I/O 都限制在 root 内”。

因此有两条可选路线：

1. 保持当前能力边界：推荐改名为 `filesystem_*`。这个名字诚实表达“本地文件系统访问”，避免 `workspace_*` 暗示只在受控工作区内操作。
2. 先收紧能力边界：给 `localFiles` 增加类似 shell cwd 的 `allowedRoots` / `allowAbsoluteOutsideRoots`，并让绝对路径也必须落在允许根内；完成后再使用 `workspace_*`。这会把产品语义改成真正的受控工作区。

如果本轮只是工具命名迁移，不同时改变权限模型，推荐选 `filesystem_*`。

如果后续收紧权限，必须覆盖所有路径入口，不只是 `LocalFileService.resolvePath()`：

- 文本读写、搜索、移动、删除。
- `resolveSendablePath` 使用的发送路径。
- `filesystem_media_view` / `filesystem_media_inspect` 的媒体读取路径。
- 本地路径导入 asset 的路径。
- 任何浏览器下载、ComfyUI 产物、WebUI 上传转入本地路径的桥接路径。

真正的 workspace 路线应使用 `realpath + relative` 做最终路径校验，或明确禁止/限制 root 内 symlink。

不推荐的候选：

- `workspace`：只有在先收紧 `localFiles` 绝对路径访问后才准确；按当前代码会低估工具权限。
- `fs`：太技术化，且暗示可访问任意文件系统。
- `disk`：不准确，项目里有虚拟根和受控路径。
- `file`：太泛，无法和已登记资源区分。
- `local`：单词太宽，不能表达文件/工作区语义。

建议迁移：

- `local_file_ls` -> `filesystem_list`
- `local_file_read` -> `filesystem_read`
- `local_file_search` -> `filesystem_search`
- `local_file_write` -> `filesystem_write`
- `local_file_patch` -> `filesystem_patch`
- `local_file_move` -> `filesystem_move`
- `local_file_delete` -> `filesystem_delete`
- `local_file_mkdir` -> `filesystem_mkdir`
- `local_file_send_to_chat` -> `filesystem_send_to_chat`
- `local_file_view_media` -> `filesystem_media_view`
- `local_file_inspect_media` -> `filesystem_media_inspect`

`filesystem_ls` 也可行，但 `list/read/search/write` 比 `ls` 更面向模型，建议借迁移机会统一为动词全称。

### `chat_file` -> `asset`

`asset` 是更好的单词前缀，因为它表达“已登记、可引用、可发送、可查看、可派生处理的资源”，不绑定来源。

不推荐的候选：

- `attachment`：太窄，只适合聊天消息附件，不适合浏览器下载、ComfyUI 产物、本地导入。
- `resource`：太宽，项目里还有浏览器资源、终端资源、live resources 等概念，容易冲突。
- `artifact`：偏生成产物，不适合用户上传或聊天附件。
- `media`：太窄，文档和普通文件不是 media。
- `file`：太泛，和路径文件混淆。

建议迁移：

- `chat_file_list` -> `asset_list`
- `chat_file_send_to_chat` -> `asset_send_to_chat`
- `chat_file_view_media` -> `asset_media_view`
- `chat_file_inspect_media` -> `asset_media_inspect`

新增文档工具自然归入：

- `asset_document_overview`
- `asset_document_search`
- `asset_document_read`
- `asset_document_inspect`
- `asset_document_summarize`（可选，不一定第一版暴露）

## 工具命名模式

推荐模式：

```text
<domain>_<subdomain?>_<action>
```

其中：

- `domain` 是单词：`filesystem`、`asset`。如果后续先收紧本地文件权限边界，也可以把 `filesystem` 替换为 `workspace`。
- `subdomain` 是资源形态或能力域：`media`、`document`、将来可有 `audio`。
- `action` 是动词：`list/read/search/view/inspect/send/summarize`。

不推荐：

```text
<domain>_<action>_<subdomain>
```

文档、媒体、音频都会各有多种操作。`asset_document_*` 比 `asset_*_document` 更像二级命名空间，工具列表也更容易聚集。

## 外部工具名与内部字段边界

`asset_*` 是面向模型的工具命名，不要求第一阶段同步重命名所有内部数据结构。

建议第一阶段只改外部接口：

- tool name
- tool description
- prompt hint
- result observation replay 文案
- next action
- toolset 暴露给模型的工具名

暂不强制重命名：

- `ChatFileStore`
- `ChatFileRecord`
- `chatFilePath`
- `ChatAttachment`
- `fileId`
- `fileRef`
- 持久化 JSON 字段

原因是这些字段已经进入 session、WebUI、browser download、ComfyUI result、测试 fixture 和历史数据语义。它们可以在后续单独做内部领域重命名；不要和第一轮工具重命名混在一起，否则迁移面会显著扩大。

## Asset 选择器参数

当前工具同时暴露 `file_id` 和 `file_ref`。改成 `asset_*` 后，参数命名需要避免制造第三套主键。

推荐：

- 对模型输入统一使用 `asset_ref` 作为首选选择器。
- 保留 `asset_id` 作为精确主键选择器，但文案中说明优先用 `asset_ref`。
- 输出可以同时返回 `asset_id`、`asset_ref`，并在必要时保留底层 `file_id`/`file_ref` 兼容字段，直到内部数据模型单独整理。
- `asset_path` 不作为第一版选择器；路径文件必须先通过导入入口登记为 asset。

工具示例：

```json
{
  "asset_ref": "img_0.png"
}
```

或：

```json
{
  "asset_id": "file_xxx"
}
```

不推荐文档工具只使用 `asset_id`。模型在聊天上下文里更常见的是可读引用，`asset_ref` 更适合作为主入口。

## Asset Handle 标准结构

`codex/napcat-group-context` 已经实现了统一文件 handle 提示层：`ChatFileHandleResult` / `LocalFileHandleResult` 的结果里同时有 `handle`、`handle_capabilities` 和 `next_actions`。这说明执行可以从 handle 层开始。

但当前 `handle` 仍是中间态：

- `ChatFileHandle.source = "chat_file"`，选择器仍是 `file_id` / `file_ref`。
- `LocalFileHandle.source = "local_file"`，选择器是 `path`，语义是路径级 filesystem handle，不是 asset handle。
- 顶层结果仍平铺 `file_id`、`file_ref`、`chat_file_path` 等 legacy 字段。

因此下一步不是从文档 parser 开始，而是先把 `ChatFileHandle` 演进或映射成模型-facing 的 `AssetHandle`。`LocalFileHandle` 应保留为 filesystem 路径 handle，不参与 asset selector。

第一步应新增或替换为 `AssetHandle`：

```ts
export interface AssetHandle {
  asset_id: string;
  asset_ref: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  origin: string;
  source_name: string;
  mime_type: string;
  size_bytes: number;
  created_at_ms: number;
  caption?: string | null;
  caption_status?: "missing" | "queued" | "ready" | "failed";
  capabilities: AssetHandleCapability[];
  legacy?: {
    file_id: string;
    file_ref: string;
    chat_file_path: string;
  };
}

export interface AssetHandleCapability {
  capability:
    | "view_media"
    | "inspect_media"
    | "send_to_chat"
    | "document_overview"
    | "document_search"
    | "document_read";
  available: boolean;
  tool: string;
  reason: string;
  args: Record<string, unknown>;
  requires?: string[];
}
```

输出约定：

- 新工具最终输出 `asset_handle` 或 `asset_handles`，不要把 handle 字段全部平铺到顶层。
- 执行迁移期可以在现有 `handle` 旁新增 `asset_handle`，并暂时保留 `handle_capabilities`，等测试和提示词迁移完成后再收敛。
- `legacy` 只用于过渡期调试和 WebUI 兼容，不作为模型首选字段。
- `capabilities[].args` 必须使用 `asset_ref` / `asset_id`，例如 `{ "asset_ref": "report.pdf" }`。
- 如果工具尚未重命名，过渡期可以让 `tool` 仍指向 `chat_file_*`，但同一阶段应在文档中标注这是兼容态；正式迁移完成后必须是 `asset_*`。

实现建议：

- 新增 `src/llm/tools/core/assetHandle.ts`。
- 让现有 `chatFileHandle.ts` 退化为兼容 wrapper，或直接迁移调用方到 `buildAssetHandleFromChatFile()`。
- `chat_file_list`、`download_asset`、`capture_screenshot`、`download_current_group_file`、`read_download_resource` 这些返回文件句柄的工具先统一输出 `asset_handle`。
- 文档工具只消费 `asset_ref` / `asset_id`，不消费 `file_ref` / `file_id`。

## 路径文件登记为 Asset

文档工具只处理 asset，因此需要明确路径文件进入 asset 的入口。文件获取分支落地后，应提供其中一种能力：

- `filesystem_import_asset`：从本地路径登记为 asset。
- 或 `asset_import_from_filesystem`：从 asset 领域发起导入。

如果目标是“路径文件能力属于 filesystem，登记资源能力属于 asset”，推荐 `asset_import_from_filesystem`，因为产物是 asset。

输入建议：

```json
{
  "path": "/tmp/report.pdf",
  "source_name": "report.pdf"
}
```

输出建议：

```json
{
  "ok": true,
  "asset_id": "file_xxx",
  "asset_ref": "report.pdf",
  "source_name": "report.pdf",
  "mime_type": "application/pdf",
  "next_actions": [
    {
      "tool": "asset_document_overview",
      "args": { "asset_ref": "report.pdf" }
    }
  ]
}
```

导入入口必须和 `filesystem_*` 使用同一套路径权限策略。

合入 `codex/napcat-group-context` 后，代码已经出现两个相关事实：

- `DownloadRuntime` 会把浏览器下载、群文件下载先变成后台 download resource，完成后再登记到 `ChatFileStore`。
- `ChatFileStore.importFileFromPath()` 对非图片文件改为 copy 进入 chat file store，不再把非图片整文件读入内存。

因此文档设计应把“登记为 asset”的入口分成三类：

- filesystem path -> asset：本地路径导入，第一版建议用 `asset_import_from_filesystem`。
- remote/download resource -> asset：浏览器下载、群文件下载等已经由 `DownloadRuntime` 承担，完成后返回 asset handle。
- generated/uploaded content -> asset：ComfyUI、WebUI 上传、聊天附件沿用对应入口。

文档工具只依赖最终 asset handle，不直接关心来源。

## 媒体工具参数

`asset_media_*` 应继续支持批量查看/精读，但参数名要和 asset 体系一致。

推荐：

- `asset_media_view` 输入 `assets`，每项允许 `{ "asset_ref": "..." }` 或 `{ "asset_id": "..." }`。
- `asset_media_inspect` 输入同样的 `assets`，并额外传 `question`。
- 最多数量沿用当前限制，例如 5。

不要继续暴露 `media_ids`，否则 `asset_media_*` 和 `asset_document_*` 会出现两套选择器。

`codex/napcat-group-context` 已经新增统一 `handle` / `handle_capabilities`，用于告诉模型某个文件可用哪些后续工具。迁移到 `asset_*` 后，chat-file 侧能力应收敛进 `asset_handle.capabilities`：

- `capabilities[].tool` 改成新工具名，例如 `asset_media_view`、`asset_send_to_chat`。
- `capabilities[].args` 使用 `asset_ref` / `asset_id`，不继续使用 `file_ref` / `media_ids`。
- 如果第一版内部仍保留 `file_ref` / `media_ids`，必须放进 `legacy` 或内部兼容层，不作为新模型-facing API。
- `LocalFileHandle.capabilities` 继续使用 `path`，后续随 `local_file_*` 改名为 `filesystem_*`，不要把它改成 `asset_ref`。

## 文档工具边界

文档能力应只面向已登记资源，即优先走 `asset_document_*`。路径文件如果要做文档处理，应先由文件获取/导入分支登记为 asset，再进入文档工具链。

这样能避免两套并行实现：

- 不做 `filesystem_document_read` 和 `asset_document_read` 两套逻辑。
- `filesystem_*` 继续负责路径级文件 I/O。
- `asset_*` 负责可缓存、可索引、可发送、可派生观察的登记资源。

### `asset_document_overview`

用途：查看文档概览。懒触发解析和摘要，不返回全文。

不建议命名为 `asset_document_view`。当前媒体工具里的 `view` 表示把媒体内容直接注入给模型查看；文档概览只返回摘要/目录/索引状态，不返回全文。`overview` 更准确。

输入：

```json
{
  "asset_ref": "report.pdf",
  "refresh": false
}
```

输出：

```json
{
  "ok": true,
  "asset_id": "file_xxx",
  "asset_ref": "report.pdf",
  "source_name": "report.pdf",
  "mime_type": "application/pdf",
  "document": {
    "status": "ready",
    "title": "report.pdf",
    "page_count": 12,
    "sheet_count": 0,
    "chunk_count": 36,
    "summary": "200-500 字中文摘要",
    "outline": [
      { "label": "1. 摘要", "page": 1 },
      { "label": "2. 风险", "page": 4 }
    ],
    "tables": []
  },
  "next_actions": [
    {
      "tool": "asset_document_search",
      "args": { "asset_ref": "report.pdf", "query": "..." }
    }
  ]
}
```

### `asset_document_search`

用途：在文档 chunks 中检索。当前 MVP 是关键词搜索；后续持久化索引后可扩展为关键词 + embedding 的 hybrid search。

输入 schema：

```json
{
  "asset_ref": "report.pdf",
  "query": "付款期限",
  "limit": 6
}
```

输出只返回命中摘要和定位，不返回大段原文：

```json
{
  "ok": true,
  "status": "ready",
  "asset_handle": { "asset_id": "file_xxx", "asset_ref": "report.pdf" },
  "query": "付款期限",
  "matches": [
    {
      "chunk_id": "chunk_3",
      "start_line": 81,
      "end_line": 120,
      "line_number": 96,
      "char_start": 12,
      "char_end": 16,
      "snippet": "命中内容的短摘..."
    }
  ],
  "returned": 1,
  "total_matches": 1,
  "truncated": false
}
```

### `asset_document_read`

用途：按行号读取局部原文。只用于精读必要片段。

当前 MVP 输入使用 `start_line`/`line_count`，后续如果引入 chunk/page/sheet 索引，再收敛到统一 locator：

```json
{
  "asset_ref": "report.pdf",
  "start_line": 120,
  "line_count": 40
}
```

返回原文窗口必须限长，并提供实际行号、总行数和截断状态：

```json
{
  "ok": true,
  "asset_handle": { "asset_id": "file_xxx", "asset_ref": "report.pdf" },
  "start_line": 120,
  "end_line": 159,
  "total_lines": 300,
  "content": "局部原文...",
  "truncated": false
}
```

### `asset_document_inspect`

用途：类似图片精读。输入问题，内部先选择少量相关片段，再调用文本精读模型回答。纯文本输入走 `llm.routingPresets.*.textInspector`，未单独配置时可退回 `summarizer`；如果输入是截图、图片表格或界面视觉内容，应继续调用图片精读工具并使用 `imageInspector` 模型。

输入 schema：

```json
{
  "asset_ref": "report.pdf",
  "question": "这份合同的付款期限和违约责任是什么？",
  "max_chunks": 6
}
```

输出必须带 asset handle 和所选片段引用；片段内模型结果用 `answered|uncertain|not_found`，不要编造。当前 MVP 顶层状态统一为：

- `ok=false`：工具执行失败，例如 asset 不存在、解析失败、模型调用失败。
- `ok=true + status=ready`：工具执行成功；具体回答状态看 `inspection.results[*].status`。

```json
{
  "ok": true,
  "status": "ready",
  "asset_handle": { "asset_id": "file_xxx", "asset_ref": "report.pdf" },
  "question": "这份合同的付款期限和违约责任是什么？",
  "selected_chunks": [
    { "chunk_id": "chunk_3", "start_line": 81, "end_line": 120, "preview": "..." }
  ],
  "combined_answer": "L81-L120: 根据该片段...",
  "inspection": {
    "ok": true,
    "results": [
      {
        "chunkId": "chunk_3",
        "startLine": 81,
        "endLine": 120,
        "status": "answered",
        "answer": "根据该片段...",
        "evidence": ["短证据"]
      }
    ]
  }
}
```

### `asset_document_summarize`

第一版可以不暴露。`asset_document_overview` 可懒触发摘要。

只有当需要手动刷新缓存、指定摘要粒度或后台批处理时，再暴露：

```json
{
  "asset_ref": "report.pdf",
  "mode": "brief",
  "refresh": true
}
```

其中 `mode` 是 enum：`brief`、`outline`、`deep`。

## 解析与缓存边界

建议新增文档服务，但不要把全文塞进 `ChatFileRecord`：

- `DocumentExtractionService`：把 PDF/DOCX/XLSX/CSV/MD/TXT 转成统一文档结构。
- `DocumentAssetStore`：保存解析产物、chunks、摘要、索引元数据。
- `DocumentSummaryService`：用 `llm.summarizer` 生成 brief/outline/key facts。
- `DocumentInspectionService`：组合检索、局部读取和问答。

当前 MVP 使用两级解析文本缓存：

- 进程内 LRU：key 包含 `fileId/fileRef/chatFilePath/sizeBytes/createdAtMs/mimeType/sourceName/absolutePath/fileStat.size/fileStat.mtimeMs/parserVersion`。
- asset store 持久缓存：`chat-files/documents/id-<sha256(asset_id) 前 32 位>/manifest.json` + `text.txt` + `chunks.jsonl`。manifest 记录同一组源文件指纹、parser、内容长度、内容 hash、chunker version 和 chunk count。目录名不直接使用原始 `asset_id`，避免污染数据导致 `.` / `..` 这类路径折叠；写入使用临时文件 + rename，读取时校验内容 hash 和 chunk metadata。

工具每次命中缓存前仍会 resolve 并 stat 实际文件；只有指纹一致时才复用持久缓存。只缓存成功解析结果，不缓存解析失败。这个缓存用于避免连续或重启后的 `overview/search/read/inspect` 反复解析 PDF/DOCX/XLSX，并让稳定 chunk metadata 可复用；它还不是 embedding 索引。

当前 MVP 的 chunk/index 是“持久 metadata + 运行时重建文本窗口”：`chunks.jsonl` 保存 `chunk_id/start_line/end_line/start_offset/end_offset`，不重复保存全文；运行时从 `text.txt` 重建 `indexText`。`overview` 返回 `chunk_count`，`search` 返回命中行及所在 `chunk_id/start_line/end_line/line_number/char_start/char_end`，`inspect` 复用同一批 chunk 做相关性选择。

缓存位置建议在 chat file root 下按 asset 隔离：

```text
chat-files/
  media/
  documents/
    id-<sha256(asset_id) 前 32 位>/
      manifest.json
      text.txt
      chunks.jsonl
      summary.json（后续）
      embeddings.sqlite 或 embeddings.jsonl
```

`chatFiles.root` 应明确是 asset store 根目录。第一版建议要求它是 `localFiles.root` 下的相对路径，避免 `ChatFileStore` 初始化目录和实际写入目录因绝对路径语义不一致而分裂。若未来允许 `chatFiles.root` 是绝对路径，应单独定义 asset store 根目录的权限策略，而不是隐式复用 `LocalFileService` 的绝对路径行为。

`ChatFileRecord` 当前已经保存图片 caption 等媒体派生状态。文档派生状态放入 `DocumentAssetStore` 会造成第一版的不对称：

- 媒体 caption 仍在 `ChatFileRecord`。
- 文档 summary/chunks/index 在 `DocumentAssetStore`。

这是可接受的过渡，但需要在后续设计里决定是否抽出统一的 `AssetDerivedStore`，把媒体、音频、文档派生状态都收敛到同一层。

### 缓存失效与清理

文档缓存 manifest 至少应记录：

- `asset_id`
- `asset_ref`
- `source_name`
- `mime_type`
- `size_bytes`
- `source_hash`
- `parser_id`
- `parser_version`
- `chunker_version`
- `summary_prompt_version`
- `embedding_profile_id`
- `created_at`
- `updated_at`

`refresh=false` 时，只有当 source hash、parser version、chunker version、summary prompt version、embedding profile 都匹配时才复用缓存。

清理规则：

- asset 删除时 best-effort 级联删除 `documents/id-<sha256(asset_id) 前 32 位>/`；清理失败只记录日志，不阻断 asset 索引删除。
- chat message GC 删除 chat_message 来源文件时，也要级联删除文档缓存。
- 启动或维护任务可扫描孤儿 `documents/<asset_id>/` 并清理。
- 同一 asset 的解析/摘要/embedding 重建需要 per-asset 锁，避免并发写坏 `chunks.jsonl` 或 summary。

后台 download resource 的生命周期也会影响文档解析：

- 下载运行中不能触发文档解析，只能返回 `status=running`。
- 下载完成并登记为 asset 后，`asset_document_overview/search/read` 才能解析。
- 下载失败或取消时，文档工具应返回 `asset_not_ready` / `download_not_completed` 这类结构化状态，而不是尝试读取临时文件。
- download resource 的短期保留策略不能替代 document cache；document cache 绑定 asset 生命周期。

## Token 策略

默认 prompt 只出现：

- asset id/ref
- source name
- mime type
- 文档摘要
- outline/table 清单
- 搜索命中的 snippets

不进入长期 transcript 的内容：

- PDF/DOCX 全文
- Excel 全表
- 大段 read 结果
- 模型内部检索 prompt

工具 observation 只保留：

- `asset_id`
- locator：`chunk_id/page_start/page_end/sheet/row_start/row_end/line_number/char_start/char_end`
- 摘要
- 是否截断
- next action

需要原文时，模型必须重新调用 `asset_document_read`。

第一版建议预算：

- `asset_document_overview.summary`：最多 800 中文字符。
- `asset_document_overview.outline`：最多 50 项。
- `asset_document_search.matches`：默认 6 项，最多 12 项；每项 snippet 最多 240 字符，并保留行号与行内字符范围。
- `asset_document_read.content`：默认最多 4000 字符或 120 行；Excel/CSV 默认最多 80 行。
- `asset_document_inspect.max_chunks`：默认 6，最多 10；每个 chunk 输入模型前最多 1200 字符；纯文本精读使用 `textInspector` 路由，视觉精读仍使用 `imageInspector`。
- document 工具的 result observation 默认 `retention=summary`，`preserveRecentRawCount=0`；近期原文也不进入 replay，只通过显式 read 再取。

如需调大预算，应走配置项，不在 prompt 或工具描述里硬编码超大上下文。

## 格式支持优先级

第一版：

- `txt/md/json/yaml`：直接文本抽取，按标题/行数切 chunk。
- `pdf`：文本型 PDF 抽取；扫描/OCR 不默认启用。
- `docx`：转 Markdown 或结构化文本。
- `xlsx/csv`：sheet 维度、表头、样例行、按行范围读取；默认不展开全表。

格式识别优先级：

1. 可信 MIME type。
2. 文件扩展名。
3. 文件头 sniff。
4. fallback 为普通二进制文件，不做文档解析。

当前第一版 parser 选型：

- PDF：`pdf-parse`，只抽取文本型 PDF；扫描/OCR 不默认启用。
- DOCX：`mammoth`，抽取 raw text。
- XLSX：`exceljs`，按 sheet 转成受限 CSV 文本；限制 sheet/row/cell 和总输出字符数，避免压缩表格展开失控。
- XLS：暂不启用解析器，返回 `unsupported_document_parser`；建议转换为 XLSX 后读取。

解析失败时应返回结构化状态，例如 `unsupported_format`、`parse_failed`、`encrypted_document`、`empty_text`，并允许用户继续发送原文件。

第二版：

- 可选 Docling/Unstructured 后端。
- 更好的表格结构、标题层级、页码定位。
- 扫描 PDF/OCR 按需启用。

## 迁移范围

若采纳 `filesystem`/`asset` 命名，实施时需要一次性更新：

- 工具 descriptor 名称、handler map。
- `toolsetCatalog` 中的 tool names、toolset id、toolset 描述。
- `resultObservationPresets` 中的 replay 文案和 next actions。
- prompt tool hints / toolset rules 中出现的旧名称。
- 测试里所有旧工具名。
- README/config 示例中提到工具名的内容。
- turn planner / toolset supplement 中的 capability 映射，例如 `local_file_access`、`local_file_io`、`chat_file_io`。
- `toolConcurrency` 对读写类工具串行策略的工具名匹配。
- mode 默认 toolset 列表。
- prompt builder 和 internal trigger 里的提示文本，例如 `workspaceFileIds`、`chatFilePaths` 是否继续作为内部字段保留。
- WebUI timeline / Sessions 页中展示 tool result、attachment、chat file path 的文案。
- Browser download、ComfyUI result、message attachment 这类自动返回 next action 的工具文案。
- `download_asset`、`read_download_resource`、`cancel_download_resource`、`download_current_group_file` 及其 background follow-up 内部触发事件。
- media tools 中的直接 view/inspect 工具和 result observation。
- WebUI / Internal API 对 derived observation purpose、tool name 标签、附件说明的展示。
- `ToolObservationResource.kind`、`DerivedObservationSourceKind`、历史压缩 replay 中的资源类型；第一版若保留 `chat_file` 内部枚举，需要在设计里标为内部兼容名。
- 任何用户可见的审批、权限、日志标签如果引用旧工具名，也要同步确认。

按项目规则，默认不保留旧工具别名。为避免与文件获取分支冲突，应等该分支合入后执行迁移。

## 未决决策

### 是否收紧 `localFiles` 绝对路径

如果采用 `filesystem_*`，第一版可以不改变权限模型，但必须在 prompt hint 里明确：

- 相对路径以 `localFiles.root` 为基准。
- 绝对路径按进程权限访问。
- 高风险写入/删除仍受工具权限、owner/operator 策略和命令审批体系约束。

如果采用 `workspace_*`，必须先改 `LocalFileService.resolvePath()` 的绝对路径策略，否则名称会误导模型。

### 是否同步改内部领域名

第一版建议不改内部领域名，只做工具名和文案迁移。后续如果要从 `ChatFile*` 内部模型迁移到 `Asset*`，需要单独设计数据迁移和 WebUI 语义调整。

### 文档索引是否复用 context store

文档 chunks 可以复用 embedding provider 和 Orama 检索思路，但不应直接混入用户长期记忆 context：

- 用户记忆是跨会话长期上下文。
- 文档 chunk 是 asset 绑定的短中期资源索引。

推荐共享 embedding service，不共享 context item 表；文档索引用独立 store，避免检索范围和保留策略耦合。

### `asset_handle.capabilities` 是否作为 asset 标准输出

`codex/napcat-group-context` 已经把 `chat_file_list`、浏览器下载、截图、群文件下载等结果收敛到 `handle + handle_capabilities + next_actions`。这和 asset 设计方向一致。

推荐把它升级为 asset 标准输出：

- 所有返回 asset 的工具都输出 `asset_handle.capabilities`。
- capabilities 以能力名为稳定字段，例如 `view_media`、`inspect_media`、`send_to_chat`、后续可有 `view_document_overview`、`search_document`。
- `tool` 和 `args` 随工具重命名更新。
- 这样模型可以少记工具细节，直接跟随 capability 提供的下一步。

## 测试矩阵

第一版实现时至少覆盖：

- 绝对路径访问按当前 `filesystem` 语义允许，或按 workspace 语义拒绝。
- symlink 指向 root 外时的读、写、搜索、删除行为。
- `resolveSendablePath`、media view、media inspect、本地导入与文本读写使用一致的路径策略。
- download resource 完成前调用文档工具时返回 not-ready 状态，完成后通过 asset handle 进入文档工具。
- `asset_handle.capabilities` 在 `asset_list`、download result、group file download result、browser screenshot result 中使用新工具名和新参数。
- `chatFiles.root` 为相对路径、绝对路径时的实际落盘位置和拒绝策略。
- asset 删除和 chat message GC 后文档缓存级联清理。
- 缓存 source hash、parser version、chunker version、summary prompt version、embedding profile 任一变化时触发重建。
- PDF/DOCX/XLSX/CSV/MD/TXT 解析成功路径和解析失败状态。
- `asset_document_read/search/overview/inspect` 的 observation 不把全文写入长期 replay。
- rename 迁移后 toolset、turn planner、tool hints、next actions、WebUI 展示不残留旧工具名。

## 后续实施优先级

当前实现状态应定义为“文档工具 MVP + asset_handle 过渡层”。文档解析、局部读取、关键词搜索、文本精读、解析文本缓存和 chunk metadata 缓存已经可用；但还不是完整的 `asset_* / filesystem_*` 命名收敛，也不是完整的 `DocumentAssetStore + summary/index 生命周期`。

### P0：可用性与 token 风险

优先处理会直接影响模型能否发现文档工具、以及长期上下文是否被原文污染的问题：

- 普通非视觉文件附件进入 batch prompt 时必须渲染 `asset_handle`，让用户直接上传 PDF/DOCX/XLSX/MD/TXT 后，模型无需先猜测 `chat_file_list`，即可按 capability 调用 `asset_document_overview/search/read/inspect`。
- `asset_document_read` 的 result observation replay 不应保留最多 4000 字原文；长期 replay 只保留 `asset_handle`、行号 locator、截断状态和短 snippet。需要原文时重新调用 `asset_document_read`。

### P1：模块边界与语义收敛

- 把 `documentTools.ts` 中的解析、持久缓存、chunk metadata 读写拆出到最小 `DocumentExtractionService` / `DocumentAssetStore`，工具层只负责参数、结果和 observation。
- 明确 `overview.summary` 语义：若仍叫 summary，则实现 `DocumentSummaryService + summary.json`；如果暂不做模型摘要，应改成 `excerpt` / `preview`，避免把开头截断误称为摘要。
- 收紧 `chatFiles.root` 语义。第一版建议要求相对路径，并补测试覆盖绝对路径拒绝或明确落盘策略。

### P2：正式命名迁移

- 将 `chat_file_*` 收敛为 `asset_*`，包括 `asset_list`、`asset_send_to_chat`、`asset_media_view`、`asset_media_inspect`。
- 将 `local_file_*` 按当前权限语义收敛为 `filesystem_*`；只有先收紧绝对路径和 symlink 边界时，才考虑 `workspace_*`。
- `asset_handle.capabilities` 中媒体和发送能力也应统一使用 `asset_ref` / `asset_id`，不继续暴露 `media_ids` / `file_ref` 作为模型首选参数。

### P3：质量与检索增强

- manifest 增加 `source_hash`、独立 parser/chunker version、summary prompt version、embedding profile。
- 增加 orphan document cache maintenance、per-asset 锁、空文本/加密/扫描 PDF 等结构化状态。
- 补有效 PDF/DOCX 成功测试、`TextInspectionService` 错误和非结构化输出测试。
- 做 embedding/hybrid search，保留当前关键词搜索作为低成本 fallback。

## 推荐结论

最终推荐：

- `8491b51 Add unified file handle hints` 合入后，文档工具的前置条件已经基本满足，可以开始 Phase 1：实现 `AssetHandle` adapter/mapping，并把返回已登记资源的工具迁移到 `asset_handle` 输出。
- Phase 2 已接入 `asset_document_overview/read/search/inspect` MVP、PDF/DOCX/XLSX parser、进程内 + asset store 解析文本与 chunk metadata 缓存，以及 `textInspector` 文本精读模型路由。下一步应优先做 summary/outline 缓存或 embedding/hybrid search，而不是继续扩大一次性上下文预算。
- 默认保持当前绝对路径访问语义时，`local_file_*` 改为 `filesystem_*`。
- 只有当先把 `localFiles` 收紧成真正的受控根目录访问时，才改为 `workspace_*`。
- `chat_file_*` 改为 `asset_*`。
- 文档工具使用 `asset_document_*`，其中概览工具命名为 `asset_document_overview`，避免和媒体 direct view 混淆。
- 执行时先实现标准 `asset_handle`，再做工具重命名和文档工具。
- 媒体工具同步使用 `asset_media_*` / `filesystem_media_*`。若采用受控工作区路线，则使用 `asset_media_*` / `workspace_media_*`。
- 文档处理只对 asset 做缓存、摘要、检索和精读；路径文件先登记为 asset 后再处理。

这套命名比 `chat_file_document_*` 更干净：既保留了二级命名空间方向，又把不准确的 `chat_file` 顶层替换成了更稳定的单词。

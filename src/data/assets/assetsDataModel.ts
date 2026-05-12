import { defineDataDomain, defineTable, integerColumn, jsonColumn, textColumn, type DataDomainModel, type DataTableModel } from "#data/model/index.ts";

export const audioFilesDataDomain = defineDataDomain({
  database: "assets",
  tableGroup: "assets.audio_files",
  schemaVersion: 1,
  tables: {
    audio_files: defineTable({
      table: "audio_files",
      primaryKey: ["id"],
      columns: [
        textColumn("id", { title: "ID", role: "id", primary: true, notNull: true }),
        textColumn("source", { title: "Source", role: "title", primary: true, notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        integerColumn("createdAt", { title: "Created", role: "time", primary: true, storageName: "created_at_ms", notNull: true }),
        textColumn("transcriptionStatus", { title: "Transcription", role: "status", primary: true, listWidth: "sm", storageName: "transcription_status", notNull: true }),
        textColumn("transcription", { title: "Transcript", nullable: true }),
        integerColumn("transcriptionUpdatedAt", { title: "Transcript Updated", role: "time", storageName: "transcription_updated_at_ms", nullable: true }),
        textColumn("transcriptionModelRef", { title: "Transcript Model", storageName: "transcription_model_ref", nullable: true }),
        textColumn("transcriptionError", { title: "Transcript Error", storageName: "transcription_error", nullable: true })
      ],
      defaultSort: [{ column: "createdAt", direction: "desc" }]
    })
  }
});

export const chatFilesDataDomain = defineDataDomain({
  database: "assets",
  tableGroup: "assets.chat_files",
  schemaVersion: 1,
  tables: {
    chat_files: defineTable({
      table: "chat_files",
      primaryKey: ["fileId"],
      columns: [
        textColumn("fileId", { title: "File ID", role: "id", primary: true, storageName: "file_id", notNull: true }),
        textColumn("sourceName", { title: "Name", role: "title", primary: true, storageName: "source_name", notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("kind", { title: "Kind", role: "badge", primary: true, notNull: true, listWidth: "xs" }),
        textColumn("origin", { title: "Origin", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("captionStatus", { title: "Caption", role: "status", primary: true, storageName: "caption_status", notNull: true, listWidth: "sm" }),
        integerColumn("createdAtMs", { title: "Created", role: "time", primary: true, storageName: "created_at_ms", notNull: true }),
        textColumn("fileRef", { title: "File Ref", storageName: "file_ref", notNull: true }),
        textColumn("chatFilePath", { title: "Path", storageName: "chat_file_path", notNull: true }),
        textColumn("mimeType", { title: "MIME", storageName: "mime_type", notNull: true }),
        integerColumn("sizeBytes", { title: "Size", storageName: "size_bytes", notNull: true }),
        jsonColumn("sourceContext", { title: "Source Context", role: "payload", storageName: "source_context_json", notNull: true }),
        textColumn("caption", { title: "Caption Text", nullable: true }),
        integerColumn("captionUpdatedAtMs", { title: "Caption Updated", role: "time", storageName: "caption_updated_at_ms", nullable: true }),
        textColumn("captionModelRef", { title: "Caption Model", storageName: "caption_model_ref", nullable: true }),
        textColumn("captionError", { title: "Caption Error", storageName: "caption_error", nullable: true })
      ],
      defaultSort: [{ column: "createdAtMs", direction: "desc" }],
      detail: {
        payloadColumns: ["sourceContext"]
      }
    })
  }
});

export const comfyTasksDataDomain = defineDataDomain({
  database: "assets",
  tableGroup: "assets.comfy_tasks",
  schemaVersion: 1,
  tables: {
    comfy_tasks: defineTable({
      table: "comfy_tasks",
      primaryKey: ["id"],
      columns: [
        textColumn("id", { title: "Task ID", role: "id", primary: true, notNull: true }),
        textColumn("status", { title: "Status", role: "status", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("templateId", { title: "Template", role: "badge", primary: true, storageName: "template_id", notNull: true }),
        textColumn("sessionId", { title: "Session", role: "subtitle", primary: true, storageName: "session_id", notNull: true }),
        textColumn("userId", { title: "User", role: "subtitle", storageName: "user_id", notNull: true }),
        textColumn("aspectRatio", { title: "Aspect", role: "badge", primary: true, storageName: "aspect_ratio", notNull: true, listWidth: "xs" }),
        integerColumn("createdAtMs", { title: "Created", role: "time", primary: true, storageName: "created_at_ms", notNull: true }),
        integerColumn("updatedAtMs", { title: "Updated", role: "time", storageName: "updated_at_ms", notNull: true }),
        textColumn("workflowFile", { title: "Workflow File", storageName: "workflow_file", notNull: true }),
        jsonColumn("workflowSnapshot", { title: "Workflow Snapshot", role: "payload", storageName: "workflow_snapshot_json", notNull: true }),
        textColumn("positivePrompt", { title: "Prompt", storageName: "positive_prompt", notNull: true }),
        integerColumn("resolvedWidth", { title: "Width", storageName: "resolved_width", notNull: true }),
        integerColumn("resolvedHeight", { title: "Height", storageName: "resolved_height", notNull: true }),
        textColumn("comfyPromptId", { title: "Comfy Prompt ID", storageName: "comfy_prompt_id", notNull: true }),
        integerColumn("autoIterationIndex", { title: "Auto Iteration", storageName: "auto_iteration_index", notNull: true }),
        integerColumn("maxAutoIterations", { title: "Max Auto Iterations", storageName: "max_auto_iterations", notNull: true }),
        textColumn("lastError", { title: "Last Error", storageName: "last_error", nullable: true }),
        integerColumn("startedAtMs", { title: "Started", role: "time", storageName: "started_at_ms", nullable: true }),
        integerColumn("finishedAtMs", { title: "Finished", role: "time", storageName: "finished_at_ms", nullable: true }),
        jsonColumn("resultFileIds", { title: "Result File IDs", role: "payload", storage: "computed", hidden: true }),
        jsonColumn("resultFiles", { title: "Result Files", role: "payload", storage: "computed", hidden: true })
      ],
      defaultSort: [{ column: "createdAtMs", direction: "desc" }],
      detail: {
        payloadColumns: ["workflowSnapshot", "resultFileIds", "resultFiles"]
      },
      children: [{
        resourceKey: "comfy_task_result_files",
        title: "Result Files",
        parentField: "id",
        childField: "taskId"
      }]
    }),
    comfy_task_result_files: defineTable({
      table: "comfy_task_result_files",
      primaryKey: ["taskId", "resultIndex"],
      columns: [
        textColumn("taskId", { title: "Task ID", role: "id", primary: true, storageName: "task_id", notNull: true }),
        integerColumn("resultIndex", { title: "Index", role: "badge", primary: true, storageName: "result_index", notNull: true, listWidth: "xs" }),
        textColumn("fileId", { title: "File ID", role: "id", primary: true, storageName: "file_id", nullable: true }),
        textColumn("filename", { title: "Filename", role: "title", primary: true, notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("subfolder", { title: "Subfolder", role: "subtitle", notNull: true }),
        textColumn("type", { title: "Type", role: "badge", primary: true, notNull: true, listWidth: "xs" })
      ],
      defaultSort: [{ column: "taskId", direction: "asc" }, { column: "resultIndex", direction: "asc" }]
    })
  }
});

export const contentSafetyAuditsDataDomain = defineDataDomain({
  database: "assets",
  tableGroup: "assets.content_safety_audits",
  schemaVersion: 1,
  tables: {
    content_safety_audits: defineTable({
      table: "content_safety_audits",
      primaryKey: ["key"],
      columns: [
        textColumn("key", { title: "Key", role: "id", primary: true, notNull: true }),
        textColumn("subjectKind", { title: "Subject", role: "badge", primary: true, storageName: "subject_kind", notNull: true, listWidth: "sm" }),
        textColumn("decision", { title: "Decision", role: "status", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("marker", { title: "Marker", primary: true, notNull: true, listWidth: "md" }),
        jsonColumn("result", { title: "Result", role: "payload", storageName: "result_json", notNull: true }),
        textColumn("originalText", { title: "Original Text", role: "payload", storageName: "original_text", nullable: true }),
        textColumn("fileId", { title: "File ID", role: "id", primary: true, storageName: "file_id", nullable: true }),
        textColumn("audioId", { title: "Audio ID", role: "id", primary: true, storageName: "audio_id", nullable: true }),
        textColumn("contentHash", { title: "Content Hash", storageName: "content_hash", nullable: true }),
        textColumn("sourceName", { title: "Source", role: "title", primary: true, storageName: "source_name", nullable: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("sessionId", { title: "Session", role: "subtitle", primary: true, storageName: "session_id", nullable: true }),
        integerColumn("checkedAtMs", { title: "Checked", role: "time", primary: true, storageName: "checked_at_ms", notNull: true }),
        integerColumn("expiresAtMs", { title: "Expires", role: "time", storageName: "expires_at_ms", nullable: true })
      ],
      defaultSort: [{ column: "checkedAtMs", direction: "desc" }, { column: "key", direction: "asc" }],
      detail: {
        payloadColumns: ["result", "originalText"]
      }
    })
  }
});

export const assetLifecycleDataDomain = defineDataDomain({
  database: "assets",
  tableGroup: "assets.lifecycle",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  tables: {
    asset_session_refs: defineTable({
      table: "asset_session_refs",
      primaryKey: ["assetKind", "assetId", "sessionId", "refKind"],
      columns: [
        textColumn("assetKind", { title: "资产类型", role: "badge", primary: true, storageName: "asset_kind", notNull: true, listWidth: "sm" }),
        textColumn("assetId", { title: "资产 ID", role: "id", primary: true, storageName: "asset_id", notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("sessionId", { title: "会话", role: "subtitle", primary: true, storageName: "session_id", notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("refKind", { title: "引用类型", role: "badge", primary: true, storageName: "ref_kind", notNull: true, listWidth: "sm" }),
        integerColumn("createdAtMs", { title: "创建时间", role: "time", storageName: "created_at_ms", notNull: true }),
        integerColumn("lastSeenAtMs", { title: "最近发现", role: "time", primary: true, storageName: "last_seen_at_ms", notNull: true }),
        integerColumn("expiresAtMs", { title: "过期时间", role: "time", storageName: "expires_at_ms", nullable: true })
      ],
      indexes: [
        { name: "idx_asset_session_refs_session", columns: ["sessionId", "assetKind", "assetId"] },
        { name: "idx_asset_session_refs_asset", columns: ["assetKind", "assetId", "sessionId"] },
        { name: "idx_asset_session_refs_expires", columns: ["expiresAtMs", "assetKind", "assetId"] },
        { name: "idx_asset_session_refs_last_seen", columns: ["lastSeenAtMs", "sessionId", "assetKind", "assetId", "refKind"] }
      ],
      defaultSort: [{ column: "lastSeenAtMs", direction: "desc" }]
    })
  }
});

export const audioFilesTableModel = requireDomainTable(audioFilesDataDomain, "audio_files");
export const chatFilesTableModel = requireDomainTable(chatFilesDataDomain, "chat_files");
export const comfyTasksTableModel = requireDomainTable(comfyTasksDataDomain, "comfy_tasks");
export const comfyTaskResultFilesTableModel = requireDomainTable(comfyTasksDataDomain, "comfy_task_result_files");
export const contentSafetyAuditsTableModel = requireDomainTable(contentSafetyAuditsDataDomain, "content_safety_audits");
export const assetSessionRefsTableModel = requireDomainTable(assetLifecycleDataDomain, "asset_session_refs");

function requireDomainTable(domain: DataDomainModel, key: string): DataTableModel {
  const table = domain.tables[key];
  if (!table) {
    throw new Error(`Missing ${key} data model`);
  }
  return table;
}

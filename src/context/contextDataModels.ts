import {
  booleanColumn,
  defineDataDomain,
  defineTable,
  integerColumn,
  jsonColumn,
  realColumn,
  textColumn,
  type DataDomainModel,
  type DataTableModel
} from "#data/model/index.ts";

export const contextItemsDataDomain = defineDataDomain({
  database: "context",
  tableGroup: "context.items",
  schemaVersion: 2,
  tables: {
    context_items: defineTable({
      table: "context_items",
      primaryKey: ["itemId"],
      columns: [
        textColumn("itemId", { title: "Item ID", role: "id", primary: true, storageName: "item_id", notNull: true }),
        textColumn("scope", { title: "Scope", role: "badge", primary: true, notNull: true, listWidth: "xs" }),
        textColumn("layer", { title: "Layer", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("subjectKind", { title: "Subject", role: "badge", primary: true, storageName: "subject_kind", notNull: true, listWidth: "sm" }),
        textColumn("subjectId", { title: "Subject ID", role: "subtitle", primary: true, storageName: "subject_id", nullable: true }),
        textColumn("sourceType", { title: "Source Type", role: "badge", primary: true, storageName: "source_type", notNull: true, listWidth: "sm" }),
        textColumn("retrievalPolicy", { title: "Retrieval", role: "badge", storageName: "retrieval_policy", notNull: true, listWidth: "sm" }),
        textColumn("status", { title: "Status", role: "status", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("userId", { title: "User", role: "subtitle", primary: true, storageName: "user_id", nullable: true }),
        textColumn("sessionId", { title: "Session", role: "subtitle", primary: true, storageName: "session_id", nullable: true }),
        textColumn("toolsetId", { title: "Toolset", role: "subtitle", storageName: "toolset_id", nullable: true }),
        textColumn("modeId", { title: "Mode", role: "subtitle", storageName: "mode_id", nullable: true }),
        textColumn("title", { title: "Title", role: "title", primary: true, nullable: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("slotKey", { title: "Slot", role: "badge", storageName: "slot_key", nullable: true, listWidth: "sm" }),
        textColumn("text", { title: "Text", role: "payload", notNull: true }),
        textColumn("embeddingTextHash", { title: "Embedding Hash", storageName: "embedding_text_hash", nullable: true }),
        textColumn("kind", { title: "Kind", role: "badge", nullable: true, listWidth: "sm" }),
        textColumn("source", { title: "Source", role: "badge", nullable: true, listWidth: "sm" }),
        realColumn("confidence", { title: "Confidence", nullable: true }),
        integerColumn("importance", { title: "Importance", role: "badge", nullable: true, listWidth: "xs" }),
        booleanColumn("pinned", { title: "Pinned", role: "badge", notNull: true, listWidth: "xs" }),
        textColumn("sensitivity", { title: "Sensitivity", role: "badge", notNull: true, listWidth: "sm" }),
        integerColumn("createdAt", { title: "Created", role: "time", storageName: "created_at", notNull: true }),
        integerColumn("updatedAt", { title: "Updated", role: "time", primary: true, storageName: "updated_at", notNull: true }),
        integerColumn("validFrom", { title: "Valid From", role: "time", storageName: "valid_from", nullable: true }),
        integerColumn("validTo", { title: "Valid To", role: "time", storageName: "valid_to", nullable: true }),
        textColumn("supersededBy", { title: "Superseded By", storageName: "superseded_by", nullable: true }),
        integerColumn("lastConfirmedAt", { title: "Last Confirmed", role: "time", storageName: "last_confirmed_at", nullable: true }),
        integerColumn("retrievedCount", { title: "Retrieved", storageName: "retrieved_count", notNull: true }),
        integerColumn("lastRetrievedAt", { title: "Last Retrieved", role: "time", storageName: "last_retrieved_at", nullable: true }),
        integerColumn("promptedCount", { title: "Prompted", storageName: "prompted_count", notNull: true }),
        integerColumn("lastPromptedAt", { title: "Last Prompted", role: "time", storageName: "last_prompted_at", nullable: true }),
        integerColumn("lastAuditedAt", { title: "Last Audited", role: "time", storageName: "last_audited_at", nullable: true }),
        textColumn("auditState", { title: "Audit State", role: "badge", storageName: "audit_state", nullable: true, listWidth: "sm" })
      ],
      defaultSort: [{ column: "updatedAt", direction: "desc" }, { column: "createdAt", direction: "desc" }, { column: "itemId", direction: "desc" }],
      detail: { payloadColumns: ["text"] },
      children: [
        {
          resourceKey: "context_item_sources",
          title: "Sources",
          parentField: "itemId",
          childField: "itemId"
        },
        {
          resourceKey: "context_item_embeddings",
          title: "Embeddings",
          parentField: "itemId",
          childField: "itemId"
        },
        {
          resourceKey: "context_manual_audit_events",
          title: "Audit Events",
          parentField: "itemId",
          childField: "itemId"
        }
      ]
    }),
    context_item_sources: defineTable({
      table: "context_item_sources",
      primaryKey: ["itemId", "sourceKind", "sourceId"],
      columns: [
        textColumn("itemId", { title: "Item ID", role: "id", primary: true, storageName: "item_id", notNull: true }),
        textColumn("sourceKind", { title: "Source Kind", role: "badge", primary: true, storageName: "source_kind", notNull: true, listWidth: "sm" }),
        textColumn("sourceId", { title: "Source ID", role: "title", primary: true, storageName: "source_id", notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        integerColumn("createdAt", { title: "Created", role: "time", primary: true, storageName: "created_at", notNull: true })
      ],
      defaultSort: [{ column: "itemId", direction: "asc" }, { column: "createdAt", direction: "asc" }]
    })
  }
});

export const contextRawMessagesDataDomain = defineDataDomain({
  database: "context",
  tableGroup: "context.raw_messages",
  schemaVersion: 1,
  tables: {
    raw_messages: defineTable({
      table: "raw_messages",
      primaryKey: ["message_id"],
      columns: [
        textColumn("message_id", { title: "Message ID", role: "id", primary: true, notNull: true }),
        textColumn("user_id", { title: "User", role: "subtitle", primary: true, nullable: true }),
        textColumn("session_id", { title: "Session", role: "subtitle", primary: true, nullable: true }),
        textColumn("chat_type", { title: "Chat", role: "badge", primary: true, nullable: true, listWidth: "xs" }),
        textColumn("role", { title: "Role", role: "badge", primary: true, notNull: true, listWidth: "xs" }),
        textColumn("speaker_id", { title: "Speaker", role: "subtitle", nullable: true }),
        integerColumn("timestamp_ms", { title: "Timestamp", role: "time", primary: true, notNull: true }),
        textColumn("text", { title: "Text", role: "payload", notNull: true }),
        jsonColumn("segments_json", { title: "Segments", role: "payload", notNull: true }),
        jsonColumn("attachment_refs_json", { title: "Attachments", role: "payload", notNull: true }),
        textColumn("sensitivity", { title: "Sensitivity", role: "badge", notNull: true, listWidth: "sm" }),
        integerColumn("ingested_at", { title: "Ingested", role: "time", primary: true, notNull: true })
      ],
      defaultSort: [{ column: "timestamp_ms", direction: "desc" }, { column: "ingested_at", direction: "desc" }],
      detail: { payloadColumns: ["text", "segments_json", "attachment_refs_json"] }
    })
  }
});

export const contextEmbeddingsDataDomain = defineDataDomain({
  database: "context",
  tableGroup: "context.embeddings",
  schemaVersion: 1,
  tables: {
    context_item_embeddings: defineTable({
      table: "context_item_embeddings",
      primaryKey: ["itemId", "embeddingProfileId"],
      columns: [
        textColumn("itemId", { title: "Item ID", role: "id", primary: true, storageName: "item_id", notNull: true }),
        textColumn("embeddingProfileId", { title: "Profile", role: "badge", primary: true, storageName: "embedding_profile_id", notNull: true, listWidth: "md" }),
        textColumn("textHash", { title: "Text Hash", storageName: "text_hash", notNull: true }),
        integerColumn("dimension", { title: "Dimension", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        integerColumn("vectorBytes", { title: "Vector Bytes", role: "badge", primary: true, storage: "computed", listWidth: "sm" }),
        integerColumn("createdAt", { title: "Created", role: "time", storageName: "created_at", notNull: true }),
        integerColumn("updatedAt", { title: "Updated", role: "time", primary: true, storageName: "updated_at", notNull: true })
      ],
      defaultSort: [{ column: "itemId", direction: "asc" }, { column: "embeddingProfileId", direction: "asc" }]
    }),
    embedding_profiles: defineTable({
      table: "embedding_profiles",
      primaryKey: ["profileId"],
      columns: [
        textColumn("profileId", { title: "Profile ID", role: "id", primary: true, storageName: "profile_id", notNull: true }),
        textColumn("instanceName", { title: "Instance", role: "badge", primary: true, storageName: "instance_name", notNull: true, listWidth: "sm" }),
        textColumn("provider", { title: "Provider", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("model", { title: "Model", role: "title", primary: true, notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        integerColumn("dimension", { title: "Dimension", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("distance", { title: "Distance", role: "badge", notNull: true, listWidth: "sm" }),
        textColumn("textPreprocessVersion", { title: "Preprocess", storageName: "text_preprocess_version", notNull: true }),
        textColumn("chunkerVersion", { title: "Chunker", storageName: "chunker_version", notNull: true }),
        booleanColumn("active", { title: "Active", role: "status", primary: true, notNull: true, listWidth: "xs" }),
        integerColumn("createdAt", { title: "Created", role: "time", primary: true, storageName: "created_at", notNull: true })
      ],
      defaultSort: [{ column: "active", direction: "desc" }, { column: "createdAt", direction: "desc" }]
    })
  }
});

export const contextMaintenanceDataDomain = defineDataDomain({
  database: "context",
  tableGroup: "context.maintenance",
  schemaVersion: 1,
  tables: {
    maintenance_jobs: defineTable({
      table: "maintenance_jobs",
      primaryKey: ["job_id"],
      columns: [
        textColumn("job_id", { title: "Job ID", role: "id", primary: true, notNull: true }),
        textColumn("job_type", { title: "Type", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("status", { title: "Status", role: "status", primary: true, notNull: true, listWidth: "sm" }),
        jsonColumn("payload_json", { title: "Payload", role: "payload", notNull: true }),
        integerColumn("scheduled_at", { title: "Scheduled", role: "time", primary: true, notNull: true }),
        integerColumn("started_at", { title: "Started", role: "time", nullable: true }),
        integerColumn("finished_at", { title: "Finished", role: "time", nullable: true }),
        textColumn("error", { title: "Error", role: "payload", nullable: true })
      ],
      defaultSort: [{ column: "scheduled_at", direction: "desc" }, { column: "job_id", direction: "desc" }],
      detail: { payloadColumns: ["payload_json", "error"] }
    }),
    manual_audit_events: defineTable({
      table: "manual_audit_events",
      primaryKey: ["eventId"],
      columns: [
        textColumn("eventId", { title: "Event ID", role: "id", primary: true, storageName: "event_id", notNull: true }),
        textColumn("eventType", { title: "Type", role: "badge", primary: true, storageName: "event_type", notNull: true, listWidth: "sm" }),
        textColumn("actorId", { title: "Actor", role: "subtitle", primary: true, storageName: "actor_id", nullable: true }),
        textColumn("itemId", { title: "Item ID", role: "id", primary: true, storageName: "item_id", nullable: true }),
        jsonColumn("payloadJson", { title: "Payload", role: "payload", storageName: "payload_json", notNull: true }),
        integerColumn("createdAt", { title: "Created", role: "time", primary: true, storageName: "created_at", notNull: true })
      ],
      defaultSort: [{ column: "createdAt", direction: "desc" }, { column: "eventId", direction: "desc" }],
      detail: { payloadColumns: ["payloadJson"] }
    })
  }
});

export const contextItemsTableModel = requireDomainTable(contextItemsDataDomain, "context_items");
export const contextItemSourcesTableModel = requireDomainTable(contextItemsDataDomain, "context_item_sources");
export const contextRawMessagesTableModel = requireDomainTable(contextRawMessagesDataDomain, "raw_messages");
export const contextItemEmbeddingsTableModel = requireDomainTable(contextEmbeddingsDataDomain, "context_item_embeddings");
export const embeddingProfilesTableModel = requireDomainTable(contextEmbeddingsDataDomain, "embedding_profiles");
export const contextMaintenanceJobsTableModel = requireDomainTable(contextMaintenanceDataDomain, "maintenance_jobs");
export const contextManualAuditEventsTableModel = requireDomainTable(contextMaintenanceDataDomain, "manual_audit_events");

function requireDomainTable(domain: DataDomainModel, key: string): DataTableModel {
  const table = domain.tables[key];
  if (!table) {
    throw new Error(`Missing ${key} data model`);
  }
  return table;
}
